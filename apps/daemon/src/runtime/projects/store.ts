import { newId, type Project } from '@milibot/shared'

import { type Db, parseJson } from '../../db/sqlite'

interface ProjectRow {
  id: string
  name: string
  slug: string
  description: string
  repos: string
  vm_path: string | null
  created_by_bot_id: string | null
  archived_at: number | null
  created_at: number
  updated_at: number
}

function toProject(row: ProjectRow): Project {
  const repos = parseJson<unknown>(row.repos, [])
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    repos: Array.isArray(repos) ? repos.filter((r): r is string => typeof r === 'string') : [],
    vmPath: row.vm_path,
    createdByBotId: row.created_by_bot_id,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export interface ProjectFields {
  name: string
  description: string
  repos: string[]
  vmPath: string | null
}

/** The `projects` rows. */
export class ProjectStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  list(includeArchived: boolean): Project[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM projects ${includeArchived ? '' : 'WHERE archived_at IS NULL'} ORDER BY lower(name), created_at`,
      )
      .all() as ProjectRow[]
    return rows.map(toProject)
  }

  find(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined
    return row ? toProject(row) : null
  }

  slugTaken(slug: string, exceptId: string | null): boolean {
    return Boolean(
      this.db.prepare('SELECT 1 FROM projects WHERE slug = ? AND id IS NOT ?').get(slug, exceptId),
    )
  }

  insert(fields: ProjectFields & { slug: string; createdByBotId: string | null }): string {
    const now = this.now()
    const id = newId('project')
    this.db
      .prepare(
        `INSERT INTO projects (id, name, slug, description, repos, vm_path, created_by_bot_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        fields.name,
        fields.slug,
        fields.description,
        JSON.stringify(fields.repos),
        fields.vmPath,
        fields.createdByBotId,
        now,
        now,
      )
    return id
  }

  update(id: string, fields: ProjectFields & { archivedAt: number | null }): void {
    this.db
      .prepare(
        `UPDATE projects SET name = ?, description = ?, repos = ?, vm_path = ?, archived_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        fields.name,
        fields.description,
        JSON.stringify(fields.repos),
        fields.vmPath,
        fields.archivedAt,
        this.now(),
        id,
      )
  }

  /** Documents, notes, plans and conversations of the project become general (foreign keys). */
  delete(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  }
}
