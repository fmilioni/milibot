import type { Migration } from '../../migrate'
import init from './0001_init'

export const workspaceMigrations: readonly Migration[] = [init]
