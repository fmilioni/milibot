import type { Migration } from '../../migrate'
import init from './0001_init'
import antigravityProvider from './0002_antigravity_provider'
import setAsideRequests from './0003_set_aside_requests'
import boardOrderAndDoingLimit from './0004_board_order_and_doing_limit'

export const workspaceMigrations: readonly Migration[] = [
  init,
  antigravityProvider,
  setAsideRequests,
  boardOrderAndDoingLimit,
]
