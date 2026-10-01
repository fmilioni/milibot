import type { LLMProvider } from '@milibot/agent/llm'

import type { Db } from '../../src/db/sqlite'
import { ModelCatalog, ProviderClients, ProviderStore } from '../../src/runtime/providers'
import { MemorySecretStore } from '../../src/secrets/secret-store'
import { openWorkspaceDb } from '../../src/workspace-db/open'

/** The providers domain over a workspace database (in memory unless given), with secrets in memory. */
export function testProviders(db: Db = openWorkspaceDb(':memory:'), override?: LLMProvider) {
  const store = new ProviderStore({ db, workspaceId: 'ws_test', secrets: new MemorySecretStore() })
  const clients = new ProviderClients({ store, override: override ?? null })
  return { store, clients, catalog: new ModelCatalog({ store, clients }) }
}
