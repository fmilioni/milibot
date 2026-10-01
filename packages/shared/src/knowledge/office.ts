import { z } from 'zod'

import { endpoint } from '../http/endpoint'

/*
 * LibreOffice in the workspace VM (preference `legacyOffice`) converts .doc, .xls, .ppt (and .ods/.odp) so
 * the knowledge base and `file_read` can read them. Opt-in because it is large; the daemon installs it
 * whenever the VM starts without it (a reset or system update replaces the system disk) and removes it when
 * the preference is turned off.
 */

/** Disk space the install takes (~357 MB installed, ~96 MB downloaded), rounded up. */
export const LEGACY_OFFICE_INSTALL_MB = 360

export const LEGACY_OFFICE_EXTENSIONS = [
  'doc',
  'dot',
  'xls',
  'xlt',
  'ppt',
  'pps',
  'pot',
  'ods',
  'odp',
] as const

/**
 * `off`: preference off (and nothing to remove); `waiting_vm`: will install (or remove) when the VM runs;
 * `installing`/`removing`: running in the VM, `progress` 0..1; `installed`; `error`: the last install or
 * removal failed (`retry` tries again).
 */
export const OfficeState = z.enum(['off', 'waiting_vm', 'installing', 'installed', 'removing', 'error'])
export type OfficeState = z.infer<typeof OfficeState>

export const OfficeStatus = z.object({
  enabled: z.boolean(),
  state: OfficeState,
  /** `preparing` = updating the package lists. */
  phase: z.enum(['preparing', 'downloading', 'installing', 'removing']).nullable(),
  progress: z.number().nullable(),
  error: z.string().nullable(),
  installMb: z.number(),
})
export type OfficeStatus = z.infer<typeof OfficeStatus>

export const officeEndpoints = {
  getOfficeStatus: endpoint({ method: 'GET', path: '/w/:workspaceId/office', response: OfficeStatus }),
  /** Needs the VM running. */
  retryOffice: endpoint({ method: 'POST', path: '/w/:workspaceId/office/retry', response: OfficeStatus }),
}
