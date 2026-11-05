import type { Migration } from '../../migrate'
import init from './0001_init'
import workspaceComputer from './0002_workspace_computer'

export const appMigrations: readonly Migration[] = [init, workspaceComputer]
