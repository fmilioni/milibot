import type { ToolDefinition } from '../../llm/provider'
import { defineTools, scalarText } from './kit'
import { PROJECT_SCOPE_ARG } from './projects'

const STR = { type: 'string' } as const
const DOC = { type: 'string', description: 'Document id (kdoc_…) or its exact title.' }

// Kept terse: the knowledge-base skill explains the parameters.
const definitions = {
  knowledge_search: {
    name: 'knowledge_search',
    description:
      "Search the knowledge base (the user's documents and the team's docs) by meaning and keywords. " +
      'Returns the best passages with document, page and id; read more with knowledge_read.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you are looking for, in words or as a question.' },
        top_k: { type: 'integer', minimum: 1, maximum: 20, description: 'Default 6.' },
        doc: DOC,
        project: PROJECT_SCOPE_ARG,
      },
      required: ['query'],
    },
  },
  knowledge_read: {
    name: 'knowledge_read',
    description:
      'Read a document: whole pages ("12" or "10-14"), the chunks a search returned (from_chunk/to_chunk) ' +
      'or, by default, from the start. Long reads come in parts of ~8k tokens: pass "part" to continue.',
    inputSchema: {
      type: 'object',
      properties: {
        doc: DOC,
        pages: STR,
        from_chunk: { type: 'integer', minimum: 1 },
        to_chunk: { type: 'integer', minimum: 1 },
        part: { type: 'integer', minimum: 1 },
      },
      required: ['doc'],
    },
  },
  knowledge_list: {
    name: 'knowledge_list',
    description: 'List documents (20 per page), optionally matching `query` over titles and summaries.',
    inputSchema: {
      type: 'object',
      properties: {
        query: STR,
        kind: STR,
        author: STR,
        project: PROJECT_SCOPE_ARG,
        page: { type: 'integer', minimum: 1 },
      },
    },
  },
  knowledge_add: {
    name: 'knowledge_add',
    description:
      'Add a copy of a file from /workspace to the knowledge base (the same path again updates it).',
    inputSchema: {
      type: 'object',
      properties: {
        path: STR,
        title: STR,
        scope: { type: 'string', enum: ['all', 'me'] },
        project: STR,
      },
      required: ['path'],
    },
  },
  knowledge_write: {
    name: 'knowledge_write',
    description: 'Create a markdown document in the knowledge base, or replace one the team wrote (`doc`).',
    inputSchema: {
      type: 'object',
      properties: {
        title: STR,
        content: STR,
        doc: DOC,
        pinned: { type: 'boolean' },
        project: STR,
      },
      required: ['title', 'content'],
    },
  },
  knowledge_edit: {
    name: 'knowledge_edit',
    description:
      'Replace exact text in a document the team wrote: old_text must match exactly once unless replace_all.',
    inputSchema: {
      type: 'object',
      properties: {
        doc: DOC,
        old_text: STR,
        new_text: STR,
        replace_all: { type: 'boolean' },
      },
      required: ['doc', 'old_text', 'new_text'],
    },
  },
  knowledge_delete: {
    name: 'knowledge_delete',
    description: 'Delete a document you wrote or added.',
    inputSchema: { type: 'object', properties: { doc: DOC }, required: ['doc'] },
  },
} satisfies Record<string, ToolDefinition>

export const knowledgeTools = defineTools({
  definitions,
  describe(name, a, view) {
    switch (name) {
      case 'knowledge_search':
      case 'knowledge_list':
        return { kind: name, detail: view.clip(scalarText(a.query), 60) }
      case 'knowledge_add':
        return { kind: name, detail: view.clip(scalarText(a.title) || scalarText(a.path), 60) }
      case 'knowledge_write':
        return { kind: name, detail: view.clip(scalarText(a.title), 60) }
      case 'knowledge_read':
      case 'knowledge_edit':
      case 'knowledge_delete': {
        // Ids mean nothing to the user: the step shows the title once the tool resolved it.
        const doc = view.clip(scalarText(a.doc), 60)
        if (!doc || /^kdoc_/i.test(doc)) return { kind: name, detail: '' }
        return { kind: name, detail: name === 'knowledge_read' ? `“${doc}”` : doc }
      }
    }
  },
  labels: {
    knowledge_search: 'searched knowledge',
    knowledge_read: 'read document',
    knowledge_list: 'documents',
    knowledge_add: 'added to knowledge',
    knowledge_write: 'wrote document',
    knowledge_edit: 'edited document',
    knowledge_delete: 'deleted document',
  },
})
