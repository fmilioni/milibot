import type { ToolDefinition } from '../../llm/provider'
import { defineTools, scalarText } from './kit'

const definitions = {
  bash: {
    name: 'bash',
    description:
      'Run a bash command as your own Linux user (login shell, in your working directory — /workspace, or ' +
      "the session's folder in a work session — unless `cwd` is given). " +
      'Non-interactive: never start editors, pagers or commands that wait for input; add -y flags. Long ' +
      'output is truncated. Use for files, git, builds, installs (sudo is available), docker.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string', description: 'Absolute path; defaults to your working directory.' },
        timeout_sec: { type: 'integer', minimum: 1, maximum: 1800, description: 'Default 120.' },
      },
      required: ['command'],
    },
  },
  file_read: {
    name: 'file_read',
    description:
      'Read a file under /workspace. Text files: numbered lines; read only the part you need of a large file ' +
      'with start_line/end_line (find it first with grep). PDF, Word/OpenDocument/EPUB/RTF, xlsx, pptx and ' +
      'images: the extracted text (OCR for scans and images) with "--- page N ---" markers, where ' +
      'offset/limit count pages (xlsx: sheets, pptx: slides). Other binary files are refused: use bash.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path under /workspace, or relative to your working directory.',
        },
        start_line: { type: 'integer', minimum: 1, description: 'Text files: first line to read (1-based).' },
        end_line: { type: 'integer', minimum: 1, description: 'Text files: last line to read (inclusive).' },
        offset: {
          type: 'integer',
          minimum: 1,
          description: 'First line (1-based); for documents, first page.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          description: 'Max lines (default 2000); for documents, max pages (default 20).',
        },
      },
      required: ['path'],
    },
  },
  file_write: {
    name: 'file_write',
    description:
      'Create or overwrite a text file under /workspace (parent directories are created). For changes to an ' +
      'existing file use file_edit or apply_patch instead of rewriting it.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  file_edit: {
    name: 'file_edit',
    description:
      'Replace exact text in a file under /workspace. Either one replacement (old_string/new_string) or ' +
      'several at once in `edits` (applied in order, each on the result of the previous one; all or none). ' +
      'Each old text must match exactly once unless replace_all is true. Read the part of the file first.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
        edits: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          description: 'Several replacements in this file, instead of old_string/new_string.',
          items: {
            type: 'object',
            properties: {
              old_text: { type: 'string' },
              new_text: { type: 'string' },
              replace_all: { type: 'boolean' },
            },
            required: ['old_text', 'new_text'],
          },
        },
      },
      required: ['path'],
    },
  },
  grep: {
    name: 'grep',
    description:
      'Search file contents (extended regex) under a folder of /workspace, skipping .git, node_modules and ' +
      'build output. Returns `path:line:text` lines. Use it to find code before reading files.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression (extended syntax).' },
        path: { type: 'string', description: 'Folder or file; defaults to your working directory.' },
        glob: { type: 'string', description: 'Only files matching this glob, e.g. "*.ts".' },
        ignore_case: { type: 'boolean' },
        context: { type: 'integer', minimum: 0, maximum: 10, description: 'Lines around each match.' },
        max_results: { type: 'integer', minimum: 1, maximum: 1000, description: 'Default 200 lines.' },
      },
      required: ['pattern'],
    },
  },
  glob: {
    name: 'glob',
    description:
      'Find files by name pattern (e.g. "**/*.test.ts", "src/*.tsx"; a pattern without "/" matches the name ' +
      'at any depth) under a folder of /workspace, most recently changed first; skips .git and node_modules.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'Folder to search; defaults to your working directory.' },
      },
      required: ['pattern'],
    },
  },
  apply_patch: {
    name: 'apply_patch',
    description:
      'Apply a unified diff (as `git diff` prints it: ---/+++ headers with a/ b/ prefixes and @@ hunks) in your ' +
      'working directory, or in `cwd`. Creates, changes and deletes files; all or nothing. Best for changes ' +
      'across several places or files.',
    inputSchema: {
      type: 'object',
      properties: {
        patch: { type: 'string' },
        cwd: {
          type: 'string',
          description: 'Folder the paths are relative to; defaults to your working directory.',
        },
      },
      required: ['patch'],
    },
  },
} satisfies Record<string, ToolDefinition>

export const fileTools = defineTools({
  definitions,
  describe(name, a, view) {
    switch (name) {
      case 'bash':
        return { kind: 'bash', detail: view.clip(scalarText(a.command)) }
      case 'file_read':
      case 'file_write':
      case 'file_edit':
        return { kind: name, detail: scalarText(a.path) }
      case 'grep': {
        const pattern = view.clip(scalarText(a.pattern), 60)
        const where = scalarText(a.path) || scalarText(a.glob)
        return { kind: 'search', detail: where ? `${pattern} in ${where}` : pattern }
      }
      case 'glob': {
        const where = scalarText(a.path)
        const pattern = scalarText(a.pattern)
        return { kind: 'file_list', detail: where ? `${pattern} in ${where}` : pattern }
      }
      case 'apply_patch': {
        const files = patchFiles(scalarText(a.patch))
        const shown = files.slice(0, 3).join(', ')
        return { kind: 'file_edit', detail: files.length > 3 ? `${shown} +${files.length - 3}` : shown }
      }
    }
  },
  labels: {
    bash: 'terminal',
    file_read: 'read',
    file_write: 'write',
    file_edit: 'edit',
    file_list: 'list',
    search: 'searched',
  },
})

/** Files a unified or Codex patch touches (its `+++`/`---` headers), without the a/ b/ prefixes. */
function patchFiles(patch: string): string[] {
  const files: string[] = []
  const lines = patch.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const codex = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/.exec(line.trim())?.[1]?.trim()
    if (codex && !files.includes(codex)) files.push(codex)
    if (!line.startsWith('+++ ')) continue
    let path = line.slice(4).split('\t')[0]?.trim() ?? ''
    if (path === '/dev/null') path = (lines[i - 1] ?? '').slice(4).split('\t')[0]?.trim() ?? ''
    path = path.replace(/^[ab]\//, '')
    if (path && path !== '/dev/null' && !files.includes(path)) files.push(path)
  }
  return files
}
