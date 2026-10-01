import { TaskStatus } from '@milibot/shared'

import type { ToolDefinition } from '../../llm/provider'
import { defineTools, scalarText } from './kit'

const definitions = {
  report_task: {
    name: 'report_task',
    description:
      'Show the user a task card in the chat: a title, a status chip and an optional link (a pull request, ' +
      'an issue, a deploy). Calling it again with the same url (or repo + pr_number) updates that card in place. ' +
      'Pull requests opened or merged with `gh pr create`/`gh pr merge` get a card automatically; use this for ' +
      'other tracked work, or to mark one as failed.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: "Short title in the user's language (max 120)." },
        status: {
          type: 'string',
          enum: [...TaskStatus.options],
          description:
            'open = in progress, review = waiting for review/approval, done = finished/merged, failed.',
        },
        url: { type: 'string', description: 'Link the card opens (https).' },
        repo: { type: 'string', description: 'Repository as owner/name.' },
        pr_number: { type: 'integer' },
        branch: { type: 'string' },
      },
      required: ['title', 'status'],
    },
  },
  share_file: {
    name: 'share_file',
    description:
      'Deliver a file to the user in this chat so they can save it on their computer (a zip, a report, an ' +
      'export). The file must be under /workspace; zip a folder first. A copy is kept under /workspace/uploads ' +
      'and shows up in the chat as its own message with a download button: do not repeat its path in your reply.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file, under /workspace.' },
        caption: {
          type: 'string',
          description: "One short line shown above the file, in the user's language.",
        },
      },
      required: ['path'],
    },
  },
} satisfies Record<string, ToolDefinition>

export const sharingTools = defineTools({
  definitions,
  describe(name, a, view) {
    if (name === 'report_task') return { kind: name, detail: view.clip(scalarText(a.title), 60) }
    return { kind: name, detail: scalarText(a.path).split('/').pop() ?? '' }
  },
  labels: { report_task: 'task card', share_file: 'shared file' },
})
