import type {
  BotScope,
  BotSkill,
  CreateSkillBody,
  Skill,
  SkillDetail,
  SkillImportCommitResult,
  SkillImportScan,
  SkillImportSource,
  SkillsFolder,
  SkillSourceCheck,
  UpdateSkillBody,
  WorkspaceEvent,
} from '@milibot/shared'
import { create } from 'zustand'

import { api } from '@/api/daemon'
import { createWorkspaceScope } from '@/api/workspace-scope'
import { type Screen, screenIs, useAppStore } from '@/features/workspace/store'
import { removeById, upsertById } from '@/lib/collections'

/** Stable empty list for selectors (a fresh `[]` re-renders on every store read). */
export const NO_SKILLS: Skill[] = []

interface SkillsState {
  /** Workspace the lists below belong to (null: not loaded yet). */
  workspaceId: string | null
  skills: Skill[]
  loaded: boolean
  folder: SkillsFolder | null
  /** Skill open on the Skills screen (null: the list). */
  detailId: string | null
  /** The import dialog is open (and with which paths dropped on the screen). */
  importing: { paths: string[] } | null
  /** Per-bot switches, loaded when the bot's settings open. */
  botSkills: Record<string, BotSkill[] | undefined>

  load(workspaceId: string): Promise<void>
  loadFolder(workspaceId: string): Promise<SkillsFolder>
  loadBot(workspaceId: string, botId: string): Promise<void>
  /** Opens a skill on the Skills screen of the settings. */
  openSkill(skillId: string | null): void
  openImport(paths?: string[]): void
  closeImport(): void
  get(workspaceId: string, skillId: string): Promise<SkillDetail>
  create(workspaceId: string, body: CreateSkillBody): Promise<SkillDetail>
  update(workspaceId: string, skillId: string, body: UpdateSkillBody): Promise<Skill>
  putContent(workspaceId: string, skillId: string, skillMd: string): Promise<SkillDetail>
  duplicate(workspaceId: string, skillId: string): Promise<SkillDetail>
  remove(workspaceId: string, skillId: string): Promise<void>
  scan(workspaceId: string, source: SkillImportSource): Promise<SkillImportScan>
  commit(
    workspaceId: string,
    scanId: string,
    paths: string[],
    allowedBots: BotScope,
  ): Promise<SkillImportCommitResult>
  updateSource(workspaceId: string, skillId: string, apply: boolean): Promise<SkillSourceCheck>
  updateBotSkill(workspaceId: string, botId: string, skillId: string, enabled: boolean): Promise<void>
  applyEvent(workspaceId: string, event: WorkspaceEvent): void
}

/** The fields of a detail that belong to the list row. */
function summary(detail: SkillDetail): Skill {
  const { skillMd: _md, files: _files, vmPath: _vm, folderPath: _folder, ...skill } = detail
  return skill
}

/** A bot's view of a skill from the skill's per-bot switches (as the daemon computes it). */
function botSkillOf(skill: Skill, botId: string): BotSkill {
  const enabled = skill.enabledFor.includes(botId)
    ? true
    : skill.disabledFor.includes(botId)
      ? false
      : skill.defaultFor !== 'first'
  const allowed = skill.allowedBots === 'all' || skill.allowedBots.includes(botId)
  return { skill, enabled, allowed, active: enabled && allowed && skill.enabled && !skill.error }
}

export const useSkillsStore = create<SkillsState>()((set, get) => {
  const { forWorkspace, isCurrent, commit } = createWorkspaceScope(get, set, () => ({
    skills: [],
    loaded: false,
    folder: null,
    detailId: null,
    importing: null,
    botSkills: {},
  }))
  const keep = (workspaceId: string, skill: Skill) =>
    commit(workspaceId, { skills: upsertById(get().skills, skill), botSkills: {} })

  return {
    workspaceId: null,
    skills: [],
    loaded: false,
    folder: null,
    detailId: null,
    importing: null,
    botSkills: {},

    async load(workspaceId) {
      forWorkspace(workspaceId)
      const skills = await api().call('listSkills', { params: { workspaceId } })
      commit(workspaceId, { skills, loaded: true })
    },

    async loadFolder(workspaceId) {
      forWorkspace(workspaceId)
      const folder = await api().call('getSkillsFolder', { params: { workspaceId } })
      commit(workspaceId, { folder })
      return folder
    },

    async loadBot(workspaceId, botId) {
      forWorkspace(workspaceId)
      const skills = await api().call('listBotSkills', { params: { workspaceId, botId } })
      commit(workspaceId, () => ({ botSkills: { ...get().botSkills, [botId]: skills } }))
    },

    openSkill(skillId) {
      const app = useAppStore.getState()
      // Scope it first, or the screen's first load() switches workspaces and drops the skill just opened.
      if (app.workspaceId) forWorkspace(app.workspaceId)
      set({ detailId: skillId })
      if (skillId) app.openSettings('skills')
    },

    openImport: (paths = []) => set({ importing: { paths } }),
    closeImport: () => set({ importing: null }),

    get: (workspaceId, skillId) => api().call('getSkill', { params: { workspaceId, skillId } }),

    async create(workspaceId, body) {
      const detail = await api().call('createSkill', { params: { workspaceId }, body })
      keep(workspaceId, summary(detail))
      return detail
    },

    async update(workspaceId, skillId, body) {
      const skill = await api().call('updateSkill', { params: { workspaceId, skillId }, body })
      keep(workspaceId, skill)
      return skill
    },

    async putContent(workspaceId, skillId, skillMd) {
      const detail = await api().call('putSkillContent', {
        params: { workspaceId, skillId },
        body: { skillMd },
      })
      keep(workspaceId, summary(detail))
      return detail
    },

    async duplicate(workspaceId, skillId) {
      const detail = await api().call('duplicateSkill', { params: { workspaceId, skillId } })
      keep(workspaceId, summary(detail))
      return detail
    },

    async remove(workspaceId, skillId) {
      await api().call('deleteSkill', { params: { workspaceId, skillId } })
      commit(workspaceId, {
        skills: removeById(get().skills, skillId),
        botSkills: {},
        detailId: get().detailId === skillId ? null : get().detailId,
      })
    },

    scan: (workspaceId, source) =>
      api().call('scanSkillImport', { params: { workspaceId }, body: { source } }),

    async commit(workspaceId, scanId, paths, allowedBots) {
      const result = await api().call('commitSkillImport', {
        params: { workspaceId },
        body: { scanId, paths, allowedBots },
      })
      for (const skill of result.imported) keep(workspaceId, skill)
      return result
    },

    async updateSource(workspaceId, skillId, apply) {
      const result = await api().call('updateSkillSource', {
        params: { workspaceId, skillId },
        body: { apply },
      })
      keep(workspaceId, summary(result.skill))
      return result
    },

    async updateBotSkill(workspaceId, botId, skillId, enabled) {
      const current = get().botSkills[botId]
      // Optimistic: the switch flips at once; a failure reloads the bot's list.
      if (current)
        set({
          botSkills: {
            ...get().botSkills,
            [botId]: current.map((s) =>
              s.skill.id === skillId
                ? { ...s, enabled, active: enabled && s.allowed && s.skill.enabled && !s.skill.error }
                : s,
            ),
          },
        })
      try {
        const saved = await api().call('updateBotSkill', {
          params: { workspaceId, botId, skillId },
          body: { enabled },
        })
        const latest = get().botSkills[botId]
        if (latest)
          set({
            botSkills: {
              ...get().botSkills,
              [botId]: latest.map((s) => (s.skill.id === skillId ? saved : s)),
            },
          })
      } catch (err) {
        await get()
          .loadBot(workspaceId, botId)
          .catch(() => undefined)
        throw err
      }
    },

    applyEvent(workspaceId, event) {
      if (!isCurrent(workspaceId)) return
      if (event.type === 'skill.updated') {
        const skill = event.payload.skill
        const botSkills = Object.fromEntries(
          Object.entries(get().botSkills).map(([botId, list]) => [
            botId,
            list?.map((s) => (s.skill.id === skill.id ? botSkillOf(skill, botId) : s)),
          ]),
        )
        set({ skills: get().loaded ? upsertById(get().skills, skill) : get().skills, botSkills })
      } else if (event.type === 'skill.deleted') {
        set({
          skills: removeById(get().skills, event.payload.skillId),
          botSkills: Object.fromEntries(
            Object.entries(get().botSkills).map(([botId, list]) => [
              botId,
              list?.filter((s) => s.skill.id !== event.payload.skillId),
            ]),
          ),
        })
      }
    },
  }
})

/** Leaving the Skills screen closes the skill (and the import) that was open there. */
export function followSkillsScreen(): () => void {
  const onSkills = (screen: Screen) => screenIs(screen, 'settings')?.section === 'skills'
  return useAppStore.subscribe((state, previous) => {
    if (onSkills(previous.screen) && !onSkills(state.screen))
      useSkillsStore.setState({ detailId: null, importing: null })
  })
}
