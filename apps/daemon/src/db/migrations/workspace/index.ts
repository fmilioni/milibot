import type { Migration } from '../../migrate'
import init from './0001_init'
import antigravityProvider from './0002_antigravity_provider'

export const workspaceMigrations: readonly Migration[] = [init, antigravityProvider]
