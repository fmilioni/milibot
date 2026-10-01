import type { Migration } from '../../migrate'

export default {
  version: 1,
  name: 'init',
  up: /* sql */ `
      -- vm_port_base: first host port of the workspace VM range (guest agent; VNC of display N at base + N).
      -- setup_step: setup screens still to go through. last_running: the runtime was running in the
      -- daemon's last session, so a new daemon may start it again.
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        icon TEXT,
        dir TEXT NOT NULL,
        close_behavior TEXT NOT NULL DEFAULT 'keep_running'
          CHECK (close_behavior IN ('keep_running', 'suspend_vm')),
        position INTEGER NOT NULL DEFAULT 0,
        vm_port_base INTEGER,
        setup_step TEXT NOT NULL CHECK (setup_step IN ('providers', 'vm', 'login', 'done')),
        last_running INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_opened_at INTEGER
      );
      CREATE UNIQUE INDEX workspaces_vm_port_base ON workspaces (vm_port_base) WHERE vm_port_base IS NOT NULL;

      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
} satisfies Migration
