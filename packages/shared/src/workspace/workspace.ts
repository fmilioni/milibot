import { z } from 'zod'

import { AvatarColor } from '../bots/avatar'
import { endpoint, Ok } from '../http/endpoint'
import { VmState } from '../vm/vm'

export const CloseBehavior = z.enum(['keep_running', 'suspend_vm'])
export type CloseBehavior = z.infer<typeof CloseBehavior>

export const RuntimeStatus = z.enum(['stopped', 'starting', 'running', 'crashed'])
export type RuntimeStatus = z.infer<typeof RuntimeStatus>

/**
 * `providers`: how the bots think and the VM size; `vm`: golden image and/or VM being created; `login`: the
 * CLI engines' sign-in inside the VM; `done`: ready (only `done` workspaces show the chat).
 */
export const SetupStep = z.enum(['providers', 'vm', 'login', 'done'])
export type SetupStep = z.infer<typeof SetupStep>

export const Workspace = z.object({
  id: z.string(),
  name: z.string().min(1).max(64),
  color: AvatarColor,
  icon: z.string().nullable(),
  dir: z.string(),
  closeBehavior: CloseBehavior,
  createdAt: z.number().int(),
  lastOpenedAt: z.number().int().nullable(),
  setup: SetupStep,
})
export type Workspace = z.infer<typeof Workspace>

export const WorkspaceSummary = Workspace.extend({
  runtimeStatus: RuntimeStatus,
})
export type WorkspaceSummary = z.infer<typeof WorkspaceSummary>

/** Most recently opened first (never opened: by creation). */
export function byRecentlyOpened(
  a: Pick<Workspace, 'lastOpenedAt' | 'createdAt'>,
  b: Pick<Workspace, 'lastOpenedAt' | 'createdAt'>,
): number {
  return (b.lastOpenedAt ?? b.createdAt) - (a.lastOpenedAt ?? a.createdAt)
}

export const Language = z.enum(['pt-BR', 'en'])
export type Language = z.infer<typeof Language>

export const ThemePreference = z.enum(['system', 'light', 'dark'])
export type ThemePreference = z.infer<typeof ThemePreference>

export const AppSettings = z.object({
  language: Language,
  theme: ThemePreference,
  /** Glances, blinks and state transitions of the bots' eyes. */
  animateEyes: z.boolean(),
  /** null follows the OS setting. */
  reduceMotion: z.boolean().nullable(),
})
export type AppSettings = z.infer<typeof AppSettings>

export const DEFAULT_APP_SETTINGS: AppSettings = {
  language: 'pt-BR',
  theme: 'system',
  animateEyes: true,
  reduceMotion: null,
}

export const WorkspaceStatus = z.object({
  vm: z.object({
    state: VmState,
    desktops: z.number().int().nonnegative(),
  }),
  usageToday: z.object({
    costUsd: z.number().nonnegative(),
    tokens: z.number().int().nonnegative(),
  }),
  /** Spend since the user last reset the counter today, else since the start of the day (`reset` tells which). */
  usageCounter: z
    .object({
      since: z.number().int(),
      reset: z.boolean(),
      costUsd: z.number().nonnegative(),
      tokens: z.number().int().nonnegative(),
    })
    .optional(),
})
export type WorkspaceStatus = z.infer<typeof WorkspaceStatus>

/** What a new workspace takes from an existing one. */
export const CopyWorkspaceOptions = z.object({
  workspaceId: z.string(),
  /** Providers and their models (configuration only). */
  providers: z.boolean().default(false),
  /** API keys of the copied providers. */
  keys: z.boolean().default(false),
  vmSize: z.boolean().default(false),
})
export type CopyWorkspaceOptions = z.input<typeof CopyWorkspaceOptions>

const CreateWorkspaceBody = z.object({
  name: z.string().trim().min(1).max(64),
  color: AvatarColor,
  icon: z.string().max(32).nullable().optional(),
  /** Starts at the setup (providers → VM → login) instead of being ready right away. */
  setup: z.boolean().optional(),
  closeBehavior: CloseBehavior.optional(),
  copyFrom: CopyWorkspaceOptions.optional(),
})

export const UpdateWorkspaceBody = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  color: AvatarColor.optional(),
  icon: z.string().max(32).nullable().optional(),
  closeBehavior: CloseBehavior.optional(),
})
export type UpdateWorkspaceBody = z.input<typeof UpdateWorkspaceBody>

export const WorkspaceOverview = z.object({
  id: z.string(),
  vmState: z.enum(['not_created', 'stopped', 'running']),
  cpus: z.number().int().nullable(),
  memGb: z.number().int().nullable(),
  dataGb: z.number().int().nullable(),
  /** Space both disks take on the host. */
  diskUsedBytes: z.number().int().nullable(),
  bots: z.number().int(),
  groups: z.number().int(),
  workingBots: z.number().int(),
})
export type WorkspaceOverview = z.infer<typeof WorkspaceOverview>

export const workspaceEndpoints = {
  getAppSettings: endpoint({ method: 'GET', path: '/app-settings', response: AppSettings }),
  updateAppSettings: endpoint({
    method: 'PATCH',
    path: '/app-settings',
    body: AppSettings.partial(),
    response: AppSettings,
  }),
  listWorkspaces: endpoint({ method: 'GET', path: '/workspaces', response: z.array(WorkspaceSummary) }),
  createWorkspace: endpoint({
    method: 'POST',
    path: '/workspaces',
    body: CreateWorkspaceBody,
    response: WorkspaceSummary,
  }),
  updateWorkspace: endpoint({
    method: 'PATCH',
    path: '/workspaces/:workspaceId',
    body: UpdateWorkspaceBody,
    response: WorkspaceSummary,
  }),
  deleteWorkspace: endpoint({ method: 'DELETE', path: '/workspaces/:workspaceId', response: Ok }),
  openWorkspace: endpoint({
    method: 'POST',
    path: '/workspaces/:workspaceId/open',
    response: WorkspaceSummary,
  }),
  /** The desktop closed the workspace's last window (applies its close behavior). */
  closeWorkspace: endpoint({
    method: 'POST',
    path: '/workspaces/:workspaceId/close',
    response: WorkspaceSummary,
  }),
  /** VM specs, disk use and bot counts of every workspace, without opening their runtimes. */
  listWorkspaceOverviews: endpoint({
    method: 'GET',
    path: '/workspaces-overview',
    response: z.array(WorkspaceOverview),
  }),
  getWorkspaceStatus: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/status',
    response: WorkspaceStatus,
  }),
}
