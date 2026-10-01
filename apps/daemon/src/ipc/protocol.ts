import type { EmbeddingKind, LocalEmbeddingFamilyId, ModelDownloadProgress } from '@milibot/agent/embeddings'
import type { Api, ApiErrorCode, CloseBehavior, EndpointName, WorkspaceEvent } from '@milibot/shared'

export type WorkspaceEndpointName = {
  [N in EndpointName]: Api[N]['path'] extends `/w/${string}` ? N : never
}[EndpointName]

/** What a stopping runtime does with a running workspace VM (`keep` leaves QEMU running detached). */
export type VmShutdownMode = 'keep' | 'stop' | 'force'

/** Messages sent over the child_process IPC channel between the supervisor and a workspace runtime. */
export type SupervisorToRuntime =
  | {
      type: 'request'
      id: number
      endpoint: WorkspaceEndpointName
      params: Record<string, string>
      query: unknown
      body: unknown
    }
  | { type: 'shutdown'; vm?: VmShutdownMode }
  /** A window opened the workspace: a runtime started in the background boots its VM now. */
  | { type: 'opened' }
  /** The workspace's "on close" setting changed (routines boot a VM kept running, wait for a suspended one). */
  | { type: 'close_behavior'; closeBehavior: CloseBehavior }
  | { type: 'call_result'; id: number; ok: true; result: unknown }
  | { type: 'call_result'; id: number; ok: false; error: { code: string; message: string } }
  /** Progress of a call still running (e.g. the download of the model a call waits for). */
  | { type: 'call_progress'; id: number; progress: unknown }

export type RuntimeToSupervisor =
  | { type: 'ready' }
  | { type: 'response'; id: number; ok: true; result: unknown }
  | {
      type: 'response'
      id: number
      ok: false
      error: { code: ApiErrorCode; message: string; details?: unknown }
    }
  | { type: 'event'; event: WorkspaceEvent }
  /** Runtime → supervisor request (see `RuntimeCallMap`); answered by `call_result`. */
  | { type: 'call'; id: number; method: RuntimeCallMethod; args: unknown }
  /** The caller gave up (abort, timeout): the supervisor stops the work and sends no result. */
  | { type: 'call_cancel'; id: number }

/** A local embedding level of the catalog, resolved by the supervisor. */
export interface EmbeddingModelRef {
  family: LocalEmbeddingFamilyId
  level: string
}

/** Services a runtime asks the supervisor for (shared by every workspace). */
export interface RuntimeCallMap {
  /** Downloads (if needed) and loads a local embedding model. */
  'embedding.prepare': {
    args: EmbeddingModelRef
    result: { loadMs: number; downloaded: boolean }
    progress: ModelDownloadProgress
  }
  'embedding.embed': {
    args: EmbeddingModelRef & { texts: string[]; kind: EmbeddingKind }
    /** `vectors` = base64 of the concatenated float32 vectors, `dimensions` long each. */
    result: { vectors: string; dimensions: number; tokens: number }
    progress: ModelDownloadProgress
  }
}

export type RuntimeCallMethod = keyof RuntimeCallMap

export const RUNTIME_ENV = {
  workspaceId: 'MILIBOT_WORKSPACE_ID',
  workspaceDir: 'MILIBOT_WORKSPACE_DIR',
  language: 'MILIBOT_LANGUAGE',
  workspaceName: 'MILIBOT_WORKSPACE_NAME',
  vmPortBase: 'MILIBOT_VM_PORT_BASE',
  /** Started by the daemon without a window (a "suspend VM" workspace leaves its VM off). */
  background: 'MILIBOT_RUNTIME_BACKGROUND',
  closeBehavior: 'MILIBOT_CLOSE_BEHAVIOR',
} as const
