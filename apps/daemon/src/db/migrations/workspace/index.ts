import type { Migration } from '../../migrate'
import init from './0001_init'
import antigravityProvider from './0002_antigravity_provider'
import setAsideRequests from './0003_set_aside_requests'

export const workspaceMigrations: readonly Migration[] = [init, antigravityProvider, setAsideRequests]
