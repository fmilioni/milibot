import {
  AppSettings,
  type AvatarColor,
  type CloseBehavior,
  DEFAULT_APP_SETTINGS,
  type SetupStep,
  type Workspace,
} from '@milibot/shared'

import { DEFAULT_VM_PORT_FIRST } from '../config/env'
import { appMigrations } from '../db/migrations/app'
import { openMigrated } from '../db/schema'
import { type Db, parseJson } from '../db/sqlite'
import { DaemonError, notFound } from '../errors'

interface WorkspaceRow {
  id: string
  name: string
  color: AvatarColor
  icon: string | null
  dir: string
  close_behavior: CloseBehavior
  created_at: number
  last_opened_at: number | null
  setup_step: SetupStep
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    icon: row.icon,
    dir: row.dir,
    closeBehavior: row.close_behavior,
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at,
    setup: row.setup_step,
  }
}

const VM_PORT_STRIDE = 100
const MAX_PORT_BASE = 65535 - VM_PORT_STRIDE

export class AppStore {
  /**
   * `vmPortFirst`: first port of new VM port ranges, below the ephemeral ranges of Linux (32768+), macOS and
   * Windows (49152+) and clear of WinRM (47001); `MILIBOT_VM_PORT_FIRST` moves it (keeps a dev/test data root
   * off the default ports).
   */
  constructor(
    readonly db: Db,
    private readonly now: () => number = Date.now,
    private readonly vmPortFirst = DEFAULT_VM_PORT_FIRST,
  ) {}

  static open(path: string, options: { vmPortFirst?: number } = {}): AppStore {
    return new AppStore(openMigrated(path, appMigrations), Date.now, options.vmPortFirst)
  }

  close(): void {
    this.db.close()
  }

  listWorkspaces(): Workspace[] {
    const rows = this.db
      .prepare('SELECT * FROM workspaces ORDER BY position, created_at')
      .all() as WorkspaceRow[]
    return rows.map(toWorkspace)
  }

  findWorkspace(id: string): Workspace | null {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined
    return row ? toWorkspace(row) : null
  }

  getWorkspace(id: string): Workspace {
    const workspace = this.findWorkspace(id)
    if (!workspace) throw notFound('workspace', id)
    return workspace
  }

  insertWorkspace(input: {
    id: string
    name: string
    color: AvatarColor
    icon: string | null
    dir: string
    closeBehavior?: CloseBehavior
    setup?: SetupStep
  }): Workspace {
    const { next } = this.db
      .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM workspaces')
      .get() as {
      next: number
    }
    this.db
      .prepare(
        `INSERT INTO workspaces (id, name, color, icon, dir, close_behavior, position, created_at, setup_step)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.name,
        input.color,
        input.icon,
        input.dir,
        input.closeBehavior ?? 'keep_running',
        next,
        this.now(),
        input.setup ?? 'done',
      )
    return this.getWorkspace(input.id)
  }

  updateWorkspace(
    id: string,
    patch: { name?: string; color?: AvatarColor; icon?: string | null; closeBehavior?: CloseBehavior },
  ): Workspace {
    const current = this.getWorkspace(id)
    this.db
      .prepare('UPDATE workspaces SET name = ?, color = ?, icon = ?, close_behavior = ? WHERE id = ?')
      .run(
        patch.name ?? current.name,
        patch.color ?? current.color,
        patch.icon === undefined ? current.icon : patch.icon,
        patch.closeBehavior ?? current.closeBehavior,
        id,
      )
    return this.getWorkspace(id)
  }

  setSetupStep(id: string, step: SetupStep): Workspace {
    this.getWorkspace(id)
    this.db.prepare('UPDATE workspaces SET setup_step = ? WHERE id = ?').run(step, id)
    return this.getWorkspace(id)
  }

  lastRunningIds(): Set<string> {
    const rows = this.db.prepare('SELECT id FROM workspaces WHERE last_running = 1').all() as { id: string }[]
    return new Set(rows.map((r) => r.id))
  }

  setLastRunning(id: string, running: boolean): void {
    this.db.prepare('UPDATE workspaces SET last_running = ? WHERE id = ?').run(running ? 1 : 0, id)
  }

  touchOpened(id: string): Workspace {
    this.db.prepare('UPDATE workspaces SET last_opened_at = ? WHERE id = ?').run(this.now(), id)
    return this.getWorkspace(id)
  }

  /**
   * Each workspace VM gets a 100-port range (guest agent + 50 VNC displays) starting at
   * `vmPortFirst`; the lowest free slot is taken and kept for the life of the workspace.
   */
  vmPortBase(id: string): number {
    this.getWorkspace(id)
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT vm_port_base FROM workspaces WHERE id = ?').get(id) as {
        vm_port_base: number | null
      }
      if (row.vm_port_base !== null) return row.vm_port_base
      return this.takePortBase(id, this.vmPortFirst)
    })()
  }

  /** A new range for a workspace whose ports another program took: the next free one above its current range. */
  moveVmPortBase(id: string): number {
    const current = this.vmPortBase(id)
    return this.db.transaction(() => this.takePortBase(id, current + VM_PORT_STRIDE))()
  }

  private takePortBase(id: string, from: number): number {
    const used = new Set(
      (
        this.db.prepare('SELECT vm_port_base FROM workspaces WHERE vm_port_base IS NOT NULL').all() as {
          vm_port_base: number
        }[]
      ).map((r) => r.vm_port_base),
    )
    let base = from
    while (used.has(base)) base += VM_PORT_STRIDE
    if (base > MAX_PORT_BASE) throw new DaemonError('conflict', 'No free VM port range left')
    this.db.prepare('UPDATE workspaces SET vm_port_base = ? WHERE id = ?').run(base, id)
    return base
  }

  deleteWorkspace(id: string): void {
    this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id)
  }

  getSettings(): AppSettings {
    const rows = this.db.prepare('SELECT key, value FROM app_settings').all() as {
      key: string
      value: string
    }[]
    const raw: Record<string, unknown> = { ...DEFAULT_APP_SETTINGS }
    for (const row of rows) raw[row.key] = parseJson<unknown>(row.value, undefined)
    const parsed = AppSettings.safeParse(raw)
    return parsed.success ? parsed.data : DEFAULT_APP_SETTINGS
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const upsert = this.db.prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    const now = this.now()
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) upsert.run(key, JSON.stringify(value), now)
      }
    })()
    return this.getSettings()
  }
}
