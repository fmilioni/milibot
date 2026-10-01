---
name: knowledge-base
description: "The workspace's documents and team docs. Load it when the user's documents may cover a task, to cite one, or before saving long reusable material."
milibot:
  tools: [knowledge]
---

# Knowledge base

- The knowledge base holds reference material: documents the user added and documentation the team wrote. Memory is for short facts needed in every session; long reusable material you produce (runbooks, specs, research, reports, how a system works) goes to the knowledge base with knowledge_write, in the user's language (knowledge_edit for small changes).
- Find with knowledge_search (passages by meaning) or knowledge_list (titles), then read only the pages or parts you need with knowledge_read.
- A file in /workspace becomes a document with knowledge_add (the same path updates it). Only delete documents you wrote or added; the user's documents are theirs.

## Tool reference

Documents are named by id (`kdoc_…`) or exact title. The user can read, download and delete every document.

- `project` of the search tools (knowledge_search, knowledge_list): default the current project plus general material; a project name to look only there (e.g. to reuse something from another project), "general" for material without a project, "all" for every project.
- `project` of knowledge_add and knowledge_write: default the conversation's current project; "general" for material every project uses (conventions, shared infrastructure); or a project name.
- `knowledge_search {query, top_k?, doc?, project?}`: `query` in words or as a question; `doc` limits it to one document; `top_k` default 6.
- `knowledge_read {doc, pages? | from_chunk?, to_chunk?, part?}`: `pages` is a page or range ("3", "3-5").
- `knowledge_list {query?, kind?, author?, project?, page?}`: `kind` is pdf, docx, xlsx, pptx, markdown, text, csv, json, code, image, html, note…; `author` is "user", "bot" or a bot name.
- `knowledge_add {path, title?, scope?, project?}`: `path` under /workspace; `scope` "all" (default: every bot finds it) or "me".
- `knowledge_write {title, content, doc?, pinned?, project?}`: `content` is the whole document in markdown; `doc` names a team document to replace; `pinned` keeps it listed in every bot's context (only documents you wrote; use sparingly).
- `knowledge_edit {doc, old_text, new_text, replace_all?}`: like file_edit; only the changed parts are indexed again.
