import { z } from 'zod'

import { ENV_SECRET_NAME_PATTERN } from '../chat/user-requests'
import { endpoint, Ok } from '../http/endpoint'

export const GithubSync = z.object({
  at: z.number().int().nullable(),
  ok: z.boolean().nullable(),
  error: z.string().nullable(),
  /** Linux users configured in the VM on the last sync. */
  users: z.number().int(),
})

export const GithubStatus = z.object({
  connected: z.boolean(),
  login: z.string().nullable(),
  name: z.string().nullable(),
  /** `fine_grained` (github_pat_…), `classic` (ghp_…) or `other`. */
  tokenKind: z.enum(['fine_grained', 'classic', 'other']).nullable(),
  /** From GitHub's `github-authentication-token-expiration` header. */
  expiresAt: z.number().int().nullable(),
  checkedAt: z.number().int().nullable(),
  sync: GithubSync,
})
export type GithubStatus = z.infer<typeof GithubStatus>

const SetGithubTokenBody = z.object({ token: z.string().trim().min(10).max(500) })

/** Search APIs `web_search` can use (it is offered to bots only while a key is set). */
export const WebSearchProvider = z.enum(['brave', 'tavily'])
export type WebSearchProvider = z.infer<typeof WebSearchProvider>

export const WebSearchStatus = z.object({
  provider: WebSearchProvider.nullable(),
  /** A few characters at the ends. */
  keyPreview: z.string().nullable(),
  checkedAt: z.number().int().nullable(),
  /** Last failed search since the runtime started (cleared by a search that works). */
  lastError: z.string().nullable(),
})
export type WebSearchStatus = z.infer<typeof WebSearchStatus>

const SetWebSearchKeyBody = z.object({
  provider: WebSearchProvider,
  key: z.string().trim().min(10).max(500),
})

export const EnvSecretScope = z.union([z.literal('all'), z.array(z.string()).min(1)])
export type EnvSecretScope = z.infer<typeof EnvSecretScope>

export const EnvSecret = z.object({
  id: z.string(),
  name: z.string(),
  scope: EnvSecretScope,
  /** A few characters at the ends of the value. */
  preview: z.string(),
  /** false = only usable by reference (`{{secret:NAME}}` and the secrets dir), not as an env var. */
  exposeAsEnv: z.boolean(),
  label: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type EnvSecret = z.infer<typeof EnvSecret>

const EnvSecretName = z.string().trim().regex(ENV_SECRET_NAME_PATTERN)
const EnvSecretLabel = z.string().trim().max(120).nullable()

export const CreateEnvSecretBody = z.object({
  name: EnvSecretName,
  value: z.string().min(1).max(32_000),
  scope: EnvSecretScope.default('all'),
  exposeAsEnv: z.boolean().optional(),
  label: EnvSecretLabel.optional(),
})
export type CreateEnvSecretBody = z.input<typeof CreateEnvSecretBody>

export const UpdateEnvSecretBody = z.object({
  name: EnvSecretName.optional(),
  value: z.string().min(1).max(32_000).optional(),
  scope: EnvSecretScope.optional(),
  exposeAsEnv: z.boolean().optional(),
  label: EnvSecretLabel.optional(),
})

export const SshKeyInfo = z.object({
  publicKey: z.string().nullable(),
  /** The key is read (and created on first use) only while the VM runs. */
  vmRunning: z.boolean(),
})
export type SshKeyInfo = z.infer<typeof SshKeyInfo>

export const credentialEndpoints = {
  getGithub: endpoint({ method: 'GET', path: '/w/:workspaceId/github', response: GithubStatus }),
  /** Checks the token with GitHub, keeps it in the secret store and logs `gh` in for every VM user. */
  setGithubToken: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/github/token',
    body: SetGithubTokenBody,
    response: GithubStatus,
  }),
  deleteGithubToken: endpoint({
    method: 'DELETE',
    path: '/w/:workspaceId/github/token',
    response: GithubStatus,
  }),
  /** Applies token and commit identity to every VM user again. */
  syncGithub: endpoint({ method: 'POST', path: '/w/:workspaceId/github/sync', response: GithubStatus }),
  getWebSearch: endpoint({ method: 'GET', path: '/w/:workspaceId/web-search', response: WebSearchStatus }),
  /** Checks the key with one search, then keeps it in the secret store. */
  setWebSearchKey: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/web-search/key',
    body: SetWebSearchKeyBody,
    response: WebSearchStatus,
  }),
  deleteWebSearchKey: endpoint({
    method: 'DELETE',
    path: '/w/:workspaceId/web-search/key',
    response: WebSearchStatus,
  }),
  listEnvSecrets: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/env-secrets',
    response: z.array(EnvSecret),
  }),
  createEnvSecret: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/env-secrets',
    body: CreateEnvSecretBody,
    response: EnvSecret,
  }),
  updateEnvSecret: endpoint({
    method: 'PATCH',
    path: '/w/:workspaceId/env-secrets/:secretId',
    body: UpdateEnvSecretBody,
    response: EnvSecret,
  }),
  deleteEnvSecret: endpoint({
    method: 'DELETE',
    path: '/w/:workspaceId/env-secrets/:secretId',
    response: Ok,
  }),
  /** Public key of the VM's `agent` user (created on first read while the VM runs). */
  getSshKey: endpoint({ method: 'GET', path: '/w/:workspaceId/ssh-key', response: SshKeyInfo }),
}
