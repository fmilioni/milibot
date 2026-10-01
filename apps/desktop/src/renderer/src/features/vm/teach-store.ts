import type { Language, ProcedureScope, WorkspaceEvent } from '@milibot/shared'
import { create } from 'zustand'

import { api } from '@/api/daemon'
import {
  INITIAL_TEACH_STATE,
  type TeachAction,
  teachReducer,
  type TeachState,
  toRecordedSteps,
} from '@/features/vm/lib/teach-recording'
import { useAppStore } from '@/features/workspace/store'

/** Screenshots still in flight when "Finish" is pressed are awaited at most this long. */
const SCREENSHOT_WAIT_MS = 6000

export interface TeachSession {
  workspaceId: string
  botId: string
  procedureId: string
  conversationId: string | null
  name: string
  /** Recording time before the current stretch (pauses excluded). */
  elapsedMs: number
  /** Start of the current stretch; null while paused. */
  runningSince: number | null
  recording: TeachState
  /** "Teach" took the screen from the bot: give it back when the recording ends. */
  tookControl: boolean
}

interface TeachStore {
  session: TeachSession | null
  /** Procedures being written by the model after "Finish" (procedure id → names), for the chat/VM hint. */
  generating: Record<string, { botId: string; name: string }>
  start(input: {
    workspaceId: string
    botId: string
    conversationId: string | null
    name: string
    userHasControl: boolean
  }): Promise<void>
  dispatch(action: TeachAction): void
  finish(input: { name: string; scope: ProcedureScope; language: Language }): Promise<void>
  discard(): Promise<void>
}

const inFlight = new Map<number, Promise<void>>()

async function releaseIfTaken(session: TeachSession): Promise<void> {
  if (!session.tookControl) return
  await useAppStore
    .getState()
    .controlBot(session.botId, 'release')
    .catch(() => undefined)
}

export const useTeachStore = create<TeachStore>()((set, get) => {
  const requestScreenshots = (before: TeachState, after: TeachState) => {
    const session = get().session
    if (!session) return
    const known = new Set(before.steps.map((s) => s.id))
    for (const step of after.steps) {
      if (known.has(step.id) || step.screenshot?.status !== 'pending') continue
      const { workspaceId, procedureId } = session
      const job = api()
        .call('teachScreenshot', {
          params: { workspaceId, procedureId },
          body: { x: step.x, y: step.y },
        })
        .then(
          (shot) => shot.sha256,
          () => null,
        )
        .then((sha) => {
          if (get().session?.procedureId === procedureId)
            get().dispatch({ type: 'screenshot', stepId: step.id, sha })
        })
        .finally(() => inFlight.delete(step.id))
      inFlight.set(step.id, job)
    }
  }

  return {
    session: null,
    generating: {},

    async start({ workspaceId, botId, conversationId, name, userHasControl }) {
      if (get().session) return
      if (!userHasControl) await useAppStore.getState().controlBot(botId, 'takeover')
      try {
        const procedure = await api().call('startTeach', {
          params: { workspaceId, botId },
          body: { conversationId, name },
        })
        set({
          session: {
            workspaceId,
            botId,
            procedureId: procedure.id,
            conversationId,
            name,
            elapsedMs: 0,
            runningSince: Date.now(),
            recording: INITIAL_TEACH_STATE,
            tookControl: !userHasControl,
          },
        })
      } catch (err) {
        if (!userHasControl)
          await useAppStore
            .getState()
            .controlBot(botId, 'release')
            .catch(() => undefined)
        throw err
      }
    },

    dispatch(action) {
      const session = get().session
      if (!session) return
      const recording = teachReducer(session.recording, action)
      if (recording === session.recording) return
      const now = Date.now()
      let { elapsedMs, runningSince } = session
      if (action.type === 'pause' && runningSince !== null) {
        elapsedMs += now - runningSince
        runningSince = null
      } else if (action.type === 'resume' && runningSince === null) {
        runningSince = now
      }
      set({ session: { ...session, recording, elapsedMs, runningSince } })
      requestScreenshots(session.recording, recording)
    },

    async finish({ name, scope, language }) {
      const session = get().session
      if (!session) return
      await Promise.race([
        Promise.allSettled([...inFlight.values()]),
        new Promise((resolve) => setTimeout(resolve, SCREENSHOT_WAIT_MS)),
      ])
      const current = get().session ?? session
      const procedure = await api().call('finishTeach', {
        params: { workspaceId: current.workspaceId, procedureId: current.procedureId },
        body: { name, scope, language, steps: toRecordedSteps(current.recording.steps) },
      })
      set({
        session: null,
        generating:
          procedure.status === 'generating'
            ? { ...get().generating, [procedure.id]: { botId: current.botId, name: procedure.name } }
            : get().generating,
      })
      await releaseIfTaken(current)
    },

    async discard() {
      const session = get().session
      if (!session) return
      set({ session: null })
      await api()
        .call('deleteProcedure', {
          params: { workspaceId: session.workspaceId, procedureId: session.procedureId },
        })
        .catch(() => undefined)
      await releaseIfTaken(session)
    },
  }
})

/** Procedures written after "Finish" leave `generating`; a deleted one ends its recording. */
export function applyTeachEvent(_workspaceId: string, event: WorkspaceEvent): void {
  const { generating, session } = useTeachStore.getState()
  if (event.type === 'procedure.updated' && event.payload.procedure.status !== 'generating') {
    if (generating[event.payload.procedure.id]) {
      const next = { ...generating }
      delete next[event.payload.procedure.id]
      useTeachStore.setState({ generating: next })
    }
  } else if (event.type === 'procedure.deleted' && session?.procedureId === event.payload.procedureId) {
    useTeachStore.setState({ session: null })
  }
}

/** A recording belongs to the window's workspace: switching workspaces drops it. */
export function followTeachWorkspace(): () => void {
  return useAppStore.subscribe((state, previous) => {
    const { generating, session } = useTeachStore.getState()
    if (state.workspaceId !== previous.workspaceId && (session || Object.keys(generating).length))
      useTeachStore.setState({ session: null, generating: {} })
  })
}

/** Recording time in ms (pauses excluded). */
export function recordingElapsed(session: TeachSession, now = Date.now()): number {
  return session.elapsedMs + (session.runningSince === null ? 0 : now - session.runningSince)
}

export function useTeachingBot(botId: string | null | undefined): boolean {
  return useTeachStore((s) => Boolean(botId) && s.session?.botId === botId)
}
