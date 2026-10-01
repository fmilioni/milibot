import type { ToolDefinition } from '../../llm/provider'
import { defineTools, scalarText } from './kit'

const definitions = {
  repo_checkout: {
    name: 'repo_checkout',
    description:
      'Get your own git worktree of a repository. Clones it into /workspace/repos/<name> if needed, fetches, ' +
      'and creates (or reuses) /workspace/worktrees/<name>/<your-slug> on branch bot/<your-slug>/<task>. ' +
      'Always work inside the returned path, never in the shared clone.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Git URL, or the name of a repo already cloned.' },
        base_branch: { type: 'string', description: 'Defaults to the remote default branch.' },
        task: { type: 'string', description: 'Short task slug for the branch name, e.g. "fix-login".' },
      },
      required: ['repo'],
    },
  },
  repo_list: {
    name: 'repo_list',
    description: 'List cloned repositories and the active worktrees (which bot works where).',
    inputSchema: { type: 'object', properties: {} },
  },
  repo_release: {
    name: 'repo_release',
    description: 'Remove your worktree of a repository after its branch was pushed/merged.',
    inputSchema: {
      type: 'object',
      properties: { repo: { type: 'string' }, force: { type: 'boolean' } },
      required: ['repo'],
    },
  },
} satisfies Record<string, ToolDefinition>

export const repoTools = defineTools({
  definitions,
  describe(name, a) {
    return { kind: name, detail: name === 'repo_list' ? '' : scalarText(a.repo) }
  },
})
