import type { Migration } from '../../migrate'

export default {
  version: 1,
  name: 'init',
  up: /* sql */ `
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE providers (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('openai_compatible', 'anthropic', 'claude_code', 'codex')),
        name TEXT NOT NULL,
        preset TEXT,
        base_url TEXT,
        extra_headers TEXT NOT NULL DEFAULT '{}',
        config TEXT NOT NULL DEFAULT '{}',
        light_model TEXT,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX providers_single_default ON providers (is_default) WHERE is_default = 1;

      -- Chat, embedding and image models are registered per provider; the same id may exist once per kind.
      -- max_output_tokens caps every chat request; dimensions is measured by a test. efforts: JSON list of the
      -- reasoning efforts a chat model accepts (NULL = unknown). An image model's price_per_request_usd is per
      -- picture and supports_vision means it takes reference images.
      CREATE TABLE provider_models (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL REFERENCES providers (id) ON DELETE CASCADE,
        kind TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat', 'embedding', 'image')),
        model_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        supports_tools INTEGER NOT NULL DEFAULT 0,
        supports_vision INTEGER NOT NULL DEFAULT 0,
        context_window INTEGER,
        max_output_tokens INTEGER,
        efforts TEXT,
        default_effort TEXT,
        dimensions INTEGER,
        price_input_per_mtok_usd REAL,
        price_cache_read_per_mtok_usd REAL,
        price_cache_write_per_mtok_usd REAL,
        price_output_per_mtok_usd REAL,
        price_per_request_usd REAL,
        enabled INTEGER NOT NULL DEFAULT 1,
        source TEXT NOT NULL CHECK (source IN ('fetched', 'manual', 'builtin')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (provider_id, kind, model_id)
      );

      -- vm_removed_at: a deleted bot keeps its display reserved until its Linux user/desktop is removed
      -- from the VM.
      CREATE TABLE bots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL DEFAULT '',
        system_prompt TEXT NOT NULL DEFAULT '',
        provider_id TEXT REFERENCES providers (id) ON DELETE SET NULL,
        model TEXT,
        effort TEXT,
        context_limit INTEGER,
        max_output_tokens INTEGER,
        avatar_shape TEXT NOT NULL,
        avatar_color TEXT NOT NULL,
        avatar_eyes TEXT NOT NULL,
        linux_uid INTEGER NOT NULL UNIQUE,
        display_num INTEGER NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'idle'
          CHECK (status IN ('idle', 'thinking', 'working', 'talking', 'paused')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        vm_removed_at INTEGER
      );

      -- Versions of each bot's persona (the editable part of its system prompt). author_type 'system' =
      -- the persona the bot had before its first versioned change.
      CREATE TABLE bot_prompt_versions (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots (id),
        text TEXT NOT NULL,
        author_type TEXT NOT NULL CHECK (author_type IN ('user', 'bot', 'system')),
        author_bot_id TEXT REFERENCES bots (id),
        reason TEXT,
        diff TEXT NOT NULL DEFAULT '',
        added INTEGER NOT NULL DEFAULT 0,
        removed INTEGER NOT NULL DEFAULT 0,
        turn_id TEXT,
        message_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX bot_prompt_versions_by_bot ON bot_prompt_versions (bot_id, created_at);

      -- A line of work inside the workspace. Knowledge documents and workspace notes without a project are
      -- general (seen from every project); a conversation's project_id is its current project.
      -- repos: JSON array of repository names/URLs.
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        repos TEXT NOT NULL DEFAULT '[]',
        vm_path TEXT,
        created_by_bot_id TEXT,
        archived_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('direct', 'group', 'internal', 'session')),
        title TEXT,
        settings TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_message_at INTEGER,
        deleted_at INTEGER,
        project_id TEXT REFERENCES projects (id) ON DELETE SET NULL
      );

      CREATE TABLE conversation_members (
        conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
        member_type TEXT NOT NULL CHECK (member_type IN ('user', 'bot')),
        bot_id TEXT REFERENCES bots (id),
        joined_at INTEGER NOT NULL,
        left_at INTEGER,
        CHECK ((member_type = 'bot') = (bot_id IS NOT NULL))
      );
      CREATE UNIQUE INDEX conversation_members_bot ON conversation_members (conversation_id, bot_id)
        WHERE bot_id IS NOT NULL;
      CREATE UNIQUE INDEX conversation_members_user ON conversation_members (conversation_id)
        WHERE member_type = 'user';
      CREATE INDEX conversation_members_by_bot ON conversation_members (bot_id);
      CREATE INDEX conversation_members_bot_conversation ON conversation_members (bot_id, conversation_id);

      -- seq is the rowid: global insertion order, pagination cursor and FTS content rowid.
      CREATE TABLE messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
        author_type TEXT NOT NULL CHECK (author_type IN ('user', 'bot', 'system')),
        author_bot_id TEXT REFERENCES bots (id),
        kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'system_event', 'activity', 'card')),
        content TEXT NOT NULL,
        payload TEXT,
        turn_id TEXT,
        compacted INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX messages_by_conversation ON messages (conversation_id, seq);

      CREATE VIRTUAL TABLE messages_fts USING fts5 (
        content,
        content = 'messages',
        content_rowid = 'seq',
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts (rowid, content) VALUES (new.seq, new.content);
      END;
      CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts (messages_fts, rowid, content) VALUES ('delete', old.seq, old.content);
      END;
      CREATE TRIGGER messages_fts_update AFTER UPDATE OF content ON messages BEGIN
        INSERT INTO messages_fts (messages_fts, rowid, content) VALUES ('delete', old.seq, old.content);
        INSERT INTO messages_fts (rowid, content) VALUES (new.seq, new.content);
      END;

      -- Hierarchical summaries: level 0 summarizes messages [from_seq, to_seq]; level n summarizes
      -- level n-1 summaries, which then point to it through parent_id.
      CREATE TABLE summaries (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
        bot_id TEXT REFERENCES bots (id),
        level INTEGER NOT NULL DEFAULT 0,
        parent_id TEXT REFERENCES summaries (id) ON DELETE SET NULL,
        from_seq INTEGER NOT NULL,
        to_seq INTEGER NOT NULL,
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL DEFAULT 0,
        llm_call_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX summaries_by_conversation ON summaries (conversation_id, bot_id, level, to_seq);
      CREATE INDEX summaries_active ON summaries (bot_id, conversation_id, from_seq) WHERE parent_id IS NULL;

      -- Notes of one bot ('bot') or shared by every bot of the workspace ('workspace', bot_id NULL,
      -- always in context).
      CREATE TABLE memories (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        bot_id TEXT REFERENCES bots (id),
        scope TEXT NOT NULL DEFAULT 'bot' CHECK (scope IN ('bot', 'workspace')),
        project_id TEXT REFERENCES projects (id) ON DELETE SET NULL,
        content TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        source_message_id TEXT,
        token_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX memories_by_bot ON memories (bot_id, pinned);
      CREATE INDEX memories_by_scope ON memories (scope, bot_id);
      CREATE INDEX memories_project ON memories (project_id) WHERE project_id IS NOT NULL;

      CREATE VIRTUAL TABLE memories_fts USING fts5 (
        content,
        content = 'memories',
        content_rowid = 'seq',
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts (rowid, content) VALUES (new.seq, new.content);
      END;
      CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts (memories_fts, rowid, content) VALUES ('delete', old.seq, old.content);
      END;
      CREATE TRIGGER memories_fts_update AFTER UPDATE OF content ON memories BEGIN
        INSERT INTO memories_fts (memories_fts, rowid, content) VALUES ('delete', old.seq, old.content);
        INSERT INTO memories_fts (rowid, content) VALUES (new.seq, new.content);
      END;

      -- Procedures taught with the Teach flow: bot_id NULL = every bot; status 'generating' = the model is
      -- writing it from the recording.
      CREATE TABLE procedures (
        id TEXT PRIMARY KEY,
        bot_id TEXT REFERENCES bots (id),
        taught_by_bot_id TEXT REFERENCES bots (id),
        conversation_id TEXT,
        name TEXT NOT NULL,
        goal TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'generating' CHECK (status IN ('recording', 'generating', 'ready')),
        preconditions TEXT NOT NULL DEFAULT '[]',
        parameters TEXT NOT NULL DEFAULT '[]',
        recording TEXT,
        llm_call_id TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX procedures_by_bot ON procedures (bot_id);

      CREATE TABLE procedure_steps (
        id TEXT PRIMARY KEY,
        procedure_id TEXT NOT NULL REFERENCES procedures (id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'other',
        action TEXT NOT NULL,
        target TEXT,
        value TEXT,
        x INTEGER,
        y INTEGER,
        narration TEXT,
        screenshot_hash TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE (procedure_id, position)
      );

      -- SKILL.md skills: the content lives in <wsDir>/skills/<slug>/ (built-ins in the app); a 'taught'
      -- row is the switch of a taught procedure (id = the procedure's id). allowed_bots is "all" or a JSON
      -- array of bot ids.
      CREATE TABLE skills (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL CHECK (source IN ('builtin', 'user', 'import', 'bot', 'taught')),
        source_json TEXT,
        author_bot_id TEXT REFERENCES bots (id),
        allowed_bots TEXT NOT NULL DEFAULT '"all"',
        enabled INTEGER NOT NULL DEFAULT 1,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Per-bot switch of a skill (no row = the skill's default).
      CREATE TABLE bot_skill_prefs (
        bot_id TEXT NOT NULL REFERENCES bots (id),
        skill_id TEXT NOT NULL REFERENCES skills (id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (bot_id, skill_id)
      );

      CREATE TABLE llm_calls (
        id TEXT PRIMARY KEY,
        bot_id TEXT REFERENCES bots (id),
        conversation_id TEXT REFERENCES conversations (id) ON DELETE SET NULL,
        turn_id TEXT,
        purpose TEXT NOT NULL DEFAULT 'turn',
        provider_id TEXT,
        provider_type TEXT NOT NULL,
        model TEXT NOT NULL,
        request_json TEXT,
        response_json TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        cached_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL,
        cost_source TEXT NOT NULL DEFAULT 'unknown' CHECK (cost_source IN ('provider', 'computed', 'unknown')),
        context_composition TEXT,
        stop_reason TEXT,
        generation_id TEXT,
        latency_ms INTEGER,
        retries INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        payload_purged_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX llm_calls_by_conversation ON llm_calls (conversation_id, created_at);
      CREATE INDEX llm_calls_by_bot ON llm_calls (bot_id, created_at);
      CREATE INDEX llm_calls_by_day ON llm_calls (created_at);

      -- Per-model breakdown of an LLM call (Claude Code modelUsage); the llm_calls row keeps the totals.
      CREATE TABLE llm_call_models (
        llm_call_id TEXT NOT NULL REFERENCES llm_calls (id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        cached_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL,
        web_search_requests INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (llm_call_id, model)
      );
      CREATE INDEX llm_call_models_by_day ON llm_call_models (created_at);

      CREATE TABLE tool_calls (
        id TEXT PRIMARY KEY,
        llm_call_id TEXT REFERENCES llm_calls (id) ON DELETE SET NULL,
        bot_id TEXT REFERENCES bots (id),
        conversation_id TEXT REFERENCES conversations (id) ON DELETE SET NULL,
        turn_id TEXT,
        tool_name TEXT NOT NULL,
        arguments_json TEXT,
        result_json TEXT,
        status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'error', 'cancelled')),
        error TEXT,
        screenshot_hash TEXT,
        payload_purged_at INTEGER,
        started_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX tool_calls_by_turn ON tool_calls (turn_id);
      CREATE INDEX tool_calls_by_llm_call ON tool_calls (llm_call_id);

      -- Patches of the files a tool call changed, shown from its activity step; kept as long as the messages.
      CREATE TABLE tool_call_diffs (
        tool_call_id TEXT PRIMARY KEY,
        conversation_id TEXT REFERENCES conversations (id) ON DELETE CASCADE,
        files_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX tool_call_diffs_by_conversation ON tool_call_diffs (conversation_id);

      CREATE TABLE sidebar_sections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        position INTEGER NOT NULL,
        collapsed INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE sidebar_items (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations (id) ON DELETE CASCADE,
        section_id TEXT REFERENCES sidebar_sections (id) ON DELETE SET NULL,
        position INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        hidden INTEGER NOT NULL DEFAULT 0,
        marked_unread INTEGER NOT NULL DEFAULT 0,
        last_read_seq INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE routines (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots (id),
        name TEXT NOT NULL DEFAULT '',
        cron TEXT NOT NULL,
        prompt TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at INTEGER,
        last_status TEXT,
        next_run_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX routines_due ON routines (enabled, next_run_at);

      -- A work session has its own worktree next to the bot's chat one for the same repository.
      CREATE TABLE repo_worktrees (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots (id),
        session_id TEXT,
        repo_name TEXT NOT NULL,
        repo_url TEXT,
        worktree_path TEXT NOT NULL,
        branch TEXT NOT NULL,
        base_branch TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
        created_at INTEGER NOT NULL,
        released_at INTEGER
      );
      CREATE UNIQUE INDEX repo_worktrees_active ON repo_worktrees (repo_name, bot_id, COALESCE(session_id, ''))
        WHERE status = 'active';

      -- Actions a bot asked for that wait for the user (card with Manter/Remover in the chat).
      CREATE TABLE confirmations (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots (id),
        conversation_id TEXT NOT NULL REFERENCES conversations (id),
        message_id TEXT,
        action TEXT NOT NULL,
        params TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );

      -- What a bot asked the user and waits for: ask_user (kind question) and request_secret (kind secret).
      -- params: the questions, or the secret's name/label/reason; never a secret value. answer: only for
      -- questions (the options chosen and the free answer).
      CREATE TABLE user_requests (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('secret', 'question')),
        bot_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        message_id TEXT,
        turn_id TEXT,
        params TEXT NOT NULL,
        answer TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'answered', 'answered_in_chat', 'declined', 'expired')),
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
      CREATE INDEX user_requests_pending ON user_requests (status, conversation_id);

      -- External MCP servers. Secret env/header values live in the Keychain
      -- (mcp.<server id>.env.<NAME> / mcp.<server id>.header.<Name>); their entries here have value NULL.
      CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        transport TEXT NOT NULL CHECK (transport IN ('stdio_vm', 'http')),
        command TEXT,
        args TEXT NOT NULL DEFAULT '[]',
        url TEXT,
        env TEXT NOT NULL DEFAULT '[]',
        headers TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        allowed_bots TEXT NOT NULL DEFAULT '"all"',
        tools TEXT NOT NULL DEFAULT '[]',
        tools_updated_at INTEGER,
        http_kind TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Per-bot switches of an allowed server (no row = enabled with every tool).
      CREATE TABLE bot_mcp_prefs (
        bot_id TEXT NOT NULL REFERENCES bots (id),
        server_id TEXT NOT NULL REFERENCES mcp_servers (id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 1,
        disabled_tools TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (bot_id, server_id)
      );

      -- Files of the chats: composer attachments (bytes staged on the host until copied into the VM) and
      -- files the bots share; all live in the VM (vm_path). 'removed': deleted from the VM.
      CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
        message_id TEXT,
        name TEXT NOT NULL,
        size INTEGER NOT NULL,
        mime_type TEXT NOT NULL,
        vm_path TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('uploading', 'queued', 'copying', 'ready', 'failed', 'removed')),
        received INTEGER NOT NULL DEFAULT 0,
        image TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX attachments_by_conversation ON attachments (conversation_id, created_at);
      CREATE INDEX attachments_by_status ON attachments (status);

      -- Knowledge base documents. Files live on the host: <wsDir>/knowledge/<id>/original.<ext> (a copy of
      -- what was added) and content.md (extracted text with <!-- page N --> markers; the document itself
      -- for source 'bot'). seq is the FTS content rowid.
      CREATE TABLE knowledge_docs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        file_name TEXT NOT NULL,
        mime TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL CHECK (kind IN ('pdf', 'docx', 'odt', 'epub', 'rtf', 'html', 'markdown', 'text',
          'csv', 'json', 'code', 'image', 'pptx', 'xlsx', 'note')),
        source TEXT NOT NULL CHECK (source IN ('upload', 'attachment', 'vm_file', 'bot')),
        source_ref TEXT,
        author_type TEXT NOT NULL CHECK (author_type IN ('user', 'bot')),
        author_bot_id TEXT REFERENCES bots (id),
        conversation_id TEXT,
        project_id TEXT REFERENCES projects (id) ON DELETE SET NULL,
        bytes INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT,
        pages INTEGER,
        status TEXT NOT NULL CHECK (status IN ('queued', 'extracting', 'summarizing', 'indexing', 'ready', 'failed')),
        error_code TEXT,
        error TEXT,
        progress REAL NOT NULL DEFAULT 0,
        summary TEXT,
        summary_model TEXT,
        -- Chunk hashes the summary was written from; a bot document is summarized again when they change a lot.
        summary_basis TEXT,
        summary_stale INTEGER NOT NULL DEFAULT 0,
        ocr_pages INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER,
        scope TEXT NOT NULL DEFAULT '"all"',
        chunk_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        indexed_at INTEGER
      );
      CREATE INDEX knowledge_docs_by_status ON knowledge_docs (status);
      CREATE INDEX knowledge_docs_by_source ON knowledge_docs (source, source_ref);
      CREATE INDEX knowledge_docs_by_update ON knowledge_docs (pinned, updated_at);
      CREATE INDEX knowledge_docs_project ON knowledge_docs (project_id);

      CREATE VIRTUAL TABLE knowledge_docs_fts USING fts5 (
        title,
        file_name,
        summary,
        content = 'knowledge_docs',
        content_rowid = 'seq',
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER knowledge_docs_fts_insert AFTER INSERT ON knowledge_docs BEGIN
        INSERT INTO knowledge_docs_fts (rowid, title, file_name, summary)
          VALUES (new.seq, new.title, new.file_name, coalesce(new.summary, ''));
      END;
      CREATE TRIGGER knowledge_docs_fts_delete AFTER DELETE ON knowledge_docs BEGIN
        INSERT INTO knowledge_docs_fts (knowledge_docs_fts, rowid, title, file_name, summary)
          VALUES ('delete', old.seq, old.title, old.file_name, coalesce(old.summary, ''));
      END;
      CREATE TRIGGER knowledge_docs_fts_update AFTER UPDATE OF title, file_name, summary ON knowledge_docs BEGIN
        INSERT INTO knowledge_docs_fts (knowledge_docs_fts, rowid, title, file_name, summary)
          VALUES ('delete', old.seq, old.title, old.file_name, coalesce(old.summary, ''));
        INSERT INTO knowledge_docs_fts (rowid, title, file_name, summary)
          VALUES (new.seq, new.title, new.file_name, coalesce(new.summary, ''));
      END;

      -- Pieces of a document's content.md (char_start/char_end: offsets in it). sha256 is the hash of the
      -- embedded text: an unchanged chunk reuses its vector.
      CREATE TABLE knowledge_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id TEXT NOT NULL REFERENCES knowledge_docs (id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        page_from INTEGER,
        page_to INTEGER,
        heading TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        tokens INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT NOT NULL,
        char_start INTEGER NOT NULL DEFAULT 0,
        char_end INTEGER NOT NULL DEFAULT 0,
        UNIQUE (doc_id, seq)
      );
      CREATE INDEX knowledge_chunks_by_sha ON knowledge_chunks (sha256);

      CREATE VIRTUAL TABLE knowledge_chunks_fts USING fts5 (
        text,
        heading,
        content = 'knowledge_chunks',
        content_rowid = 'id',
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER knowledge_chunks_fts_insert AFTER INSERT ON knowledge_chunks BEGIN
        INSERT INTO knowledge_chunks_fts (rowid, text, heading) VALUES (new.id, new.text, new.heading);
      END;
      CREATE TRIGGER knowledge_chunks_fts_delete AFTER DELETE ON knowledge_chunks BEGIN
        INSERT INTO knowledge_chunks_fts (knowledge_chunks_fts, rowid, text, heading)
          VALUES ('delete', old.id, old.text, old.heading);
      END;
      CREATE TRIGGER knowledge_chunks_fts_update AFTER UPDATE OF text, heading ON knowledge_chunks BEGIN
        INSERT INTO knowledge_chunks_fts (knowledge_chunks_fts, rowid, text, heading)
          VALUES ('delete', old.id, old.text, old.heading);
        INSERT INTO knowledge_chunks_fts (rowid, text, heading) VALUES (new.id, new.text, new.heading);
      END;

      -- Unit vectors quantized to int8 (value ≈ byte * scale), one per chunk and vector space (model).
      CREATE TABLE knowledge_vectors (
        chunk_id INTEGER NOT NULL REFERENCES knowledge_chunks (id) ON DELETE CASCADE,
        space TEXT NOT NULL,
        dims INTEGER NOT NULL,
        vector BLOB NOT NULL,
        scale REAL NOT NULL,
        PRIMARY KEY (chunk_id, space)
      );
      CREATE INDEX knowledge_vectors_by_space ON knowledge_vectors (space);

      -- Vector of each document's summary (document suggestions and knowledge_list queries).
      CREATE TABLE knowledge_doc_vectors (
        doc_id TEXT NOT NULL REFERENCES knowledge_docs (id) ON DELETE CASCADE,
        space TEXT NOT NULL,
        dims INTEGER NOT NULL,
        vector BLOB NOT NULL,
        scale REAL NOT NULL,
        sha256 TEXT NOT NULL,
        PRIMARY KEY (doc_id, space)
      );

      -- Plans a bot proposes for large work (code or anything else): markdown body + steps, a summary the
      -- author writes, approval by the user, then execution tracked step by step. seq is the FTS rowid;
      -- session_id links the work session that executes it; deleted_at hides it (the cards say "removed").
      CREATE TABLE plans (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        bot_id TEXT NOT NULL,
        project_id TEXT REFERENCES projects (id) ON DELETE SET NULL,
        conversation_id TEXT NOT NULL,
        session_id TEXT,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        body TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        execution TEXT NOT NULL DEFAULT 'chat' CHECK (execution IN ('chat', 'session')),
        -- "Mergear o PR ao final" chosen when approving; NULL follows the workspace's git.auto_merge_prs.
        merge_pr INTEGER CHECK (merge_pr IN (0, 1)),
        -- Model (ModelChoice JSON) the executing session runs on; NULL = the bot's own.
        model_spec TEXT,
        -- Absolute folder under /workspace the plan's session works in when it has no repository; NULL = its own.
        folder TEXT,
        status TEXT NOT NULL CHECK (status IN ('draft', 'awaiting_approval', 'approved', 'executing', 'done',
          'rejected', 'cancelled')),
        feedback TEXT,
        message_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        decided_at INTEGER,
        finished_at INTEGER,
        deleted_at INTEGER
      );
      CREATE INDEX plans_by_conversation ON plans (conversation_id, status);
      CREATE INDEX plans_by_update ON plans (updated_at);

      CREATE VIRTUAL TABLE plans_fts USING fts5 (
        title,
        summary,
        content = 'plans',
        content_rowid = 'seq',
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER plans_fts_insert AFTER INSERT ON plans BEGIN
        INSERT INTO plans_fts (rowid, title, summary) VALUES (new.seq, new.title, new.summary);
      END;
      CREATE TRIGGER plans_fts_delete AFTER DELETE ON plans BEGIN
        INSERT INTO plans_fts (plans_fts, rowid, title, summary) VALUES ('delete', old.seq, old.title, old.summary);
      END;
      CREATE TRIGGER plans_fts_update AFTER UPDATE OF title, summary ON plans BEGIN
        INSERT INTO plans_fts (plans_fts, rowid, title, summary) VALUES ('delete', old.seq, old.title, old.summary);
        INSERT INTO plans_fts (rowid, title, summary) VALUES (new.seq, new.title, new.summary);
      END;

      -- What was sent for approval each time (plan_submit) and how the user answered it.
      CREATE TABLE plan_revisions (
        plan_id TEXT NOT NULL REFERENCES plans (id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        body TEXT NOT NULL,
        steps TEXT NOT NULL DEFAULT '[]',
        feedback TEXT,
        outcome TEXT CHECK (outcome IN ('approved', 'changes_requested', 'rejected')),
        message_id TEXT,
        created_at INTEGER NOT NULL,
        decided_at INTEGER,
        PRIMARY KEY (plan_id, revision)
      );

      -- Step lists of a plan (owner_type plan) or of a work session.
      CREATE TABLE todo_items (
        id TEXT PRIMARY KEY,
        owner_type TEXT NOT NULL CHECK (owner_type IN ('plan', 'session')),
        owner_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        title TEXT NOT NULL,
        detail TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done', 'skipped')),
        note TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX todo_items_by_owner ON todo_items (owner_type, owner_id, position);

      -- Summary vectors of the plans, in the knowledge base's vector space (same format as knowledge_doc_vectors).
      CREATE TABLE plan_vectors (
        plan_id TEXT NOT NULL REFERENCES plans (id) ON DELETE CASCADE,
        space TEXT NOT NULL,
        dims INTEGER NOT NULL,
        vector BLOB NOT NULL,
        scale REAL NOT NULL,
        sha256 TEXT NOT NULL,
        PRIMARY KEY (plan_id, space)
      );

      -- Long work of a bot in its own conversation (type 'session') and lane, next to its chats. cwd is where
      -- it works in the VM (its own worktree when repo_name is set); base_commit/shadow_git keep the baseline
      -- the changes are measured against (baseline_error: why it could not be taken, e.g. too_large);
      -- changes_json: the last computed changes against it; cli_generation counts the CLI sessions (Claude Code
      -- sessions, Codex threads) it went through.
      CREATE TABLE work_sessions (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots (id),
        conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations (id),
        origin_conversation_id TEXT NOT NULL,
        origin_message_id TEXT,
        plan_id TEXT REFERENCES plans (id) ON DELETE SET NULL,
        project_id TEXT REFERENCES projects (id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('preparing', 'running', 'idle', 'done', 'failed', 'cancelled')),
        cwd TEXT,
        repo_name TEXT,
        worktree_id TEXT,
        base_commit TEXT,
        shadow_git TEXT,
        baseline_error TEXT,
        changes_json TEXT,
        -- When the patches of a finished session were saved (work_session_patches), NULL = never.
        patches_at INTEGER,
        cli_generation INTEGER NOT NULL DEFAULT 0,
        -- Model (ModelChoice JSON) the session's lane runs on; NULL = the bot's own.
        model_spec TEXT,
        result_summary TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        finished_at INTEGER,
        deleted_at INTEGER
      );
      CREATE INDEX work_sessions_by_bot ON work_sessions (bot_id, status);

      -- Patch per changed file saved when a session finishes, so its changes outlive the VM and the folder.
      CREATE TABLE work_session_patches (
        session_id TEXT NOT NULL REFERENCES work_sessions (id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        patch TEXT NOT NULL,
        truncated INTEGER NOT NULL,
        PRIMARY KEY (session_id, path)
      );

      -- What an API-provider bot sent and received in a session lane (tool calls and results included), in
      -- order; entries up to the lane's latest summary are compacted.
      CREATE TABLE session_transcript (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES work_sessions (id) ON DELETE CASCADE,
        lane_key TEXT NOT NULL,
        turn_id TEXT,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
        message TEXT NOT NULL,
        tokens INTEGER NOT NULL,
        compacted INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX session_transcript_by_lane ON session_transcript (session_id, lane_key, seq);

      -- Rolling summary of a lane's compacted transcript (the newest one covers everything up to to_seq).
      CREATE TABLE session_summaries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES work_sessions (id) ON DELETE CASCADE,
        lane_key TEXT NOT NULL,
        to_seq INTEGER NOT NULL,
        content TEXT NOT NULL,
        tokens INTEGER NOT NULL,
        llm_call_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX session_summaries_by_lane ON session_summaries (session_id, lane_key, to_seq);

      -- Canvas of frames a bot draws. themes_json: ordered names (the first is the default); tokens_json:
      -- [{name, type, value, values}]; fonts_json: Google Fonts families. message_id: the chat card.
      CREATE TABLE designs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        conversation_id TEXT,
        bot_id TEXT,
        themes_json TEXT NOT NULL DEFAULT '[]',
        tokens_json TEXT NOT NULL DEFAULT '[]',
        fonts_json TEXT NOT NULL DEFAULT '[]',
        message_id TEXT,
        thumbnail_sha TEXT,
        archived_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX designs_by_conversation ON designs (conversation_id, updated_at);

      -- height NULL = grows with its content (measured_height: last rendered height); theme NULL = default.
      CREATE TABLE design_frames (
        id TEXT PRIMARY KEY,
        design_id TEXT NOT NULL REFERENCES designs (id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER,
        measured_height INTEGER,
        theme TEXT,
        html TEXT NOT NULL,
        css TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        -- NULL: a frame of HTML the bot writes. Else an art frame design_draw draws in the background
        -- (html = <img src="asset:..."> once ready); art_json: {prompt, botId, error, startedAt, finishedAt}.
        art_status TEXT CHECK (art_status IN ('drawing', 'ready', 'failed')),
        art_json TEXT
      );
      CREATE INDEX design_frames_by_design ON design_frames (design_id, position);

      -- snapshot_json: {before, after} of the frame (frame_id set) or of themes/tokens/fonts (frame_id NULL).
      CREATE TABLE design_revisions (
        id TEXT PRIMARY KEY,
        design_id TEXT NOT NULL REFERENCES designs (id) ON DELETE CASCADE,
        frame_id TEXT,
        author_type TEXT NOT NULL CHECK (author_type IN ('bot', 'user')),
        author_bot_id TEXT,
        turn_id TEXT,
        summary TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX design_revisions_by_design ON design_revisions (design_id, created_at);

      -- Kanban boards bots plan large goals on. seq is the FTS rowid; completed_at is set while every card is
      -- done or dropped; archived boards leave what bots list; due_date is a local YYYY-MM-DD; message_id: the
      -- chat card (boards the user makes have none).
      CREATE TABLE boards (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        project_id TEXT REFERENCES projects (id) ON DELETE SET NULL,
        bot_id TEXT,
        conversation_id TEXT,
        message_id TEXT,
        due_date TEXT,
        completed_at INTEGER,
        archived_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX boards_by_update ON boards (updated_at);

      CREATE VIRTUAL TABLE boards_fts USING fts5 (
        title,
        summary,
        content = 'boards',
        content_rowid = 'seq',
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER boards_fts_insert AFTER INSERT ON boards BEGIN
        INSERT INTO boards_fts (rowid, title, summary) VALUES (new.seq, new.title, new.summary);
      END;
      CREATE TRIGGER boards_fts_delete AFTER DELETE ON boards BEGIN
        INSERT INTO boards_fts (boards_fts, rowid, title, summary) VALUES ('delete', old.seq, old.title, old.summary);
      END;
      CREATE TRIGGER boards_fts_update AFTER UPDATE OF title, summary ON boards BEGIN
        INSERT INTO boards_fts (boards_fts, rowid, title, summary) VALUES ('delete', old.seq, old.title, old.summary);
        INSERT INTO boards_fts (rowid, title, summary) VALUES (new.seq, new.title, new.summary);
      END;

      -- position: order inside its status column, from 0; assignee_bot_id: the bot working on it;
      -- created_by_bot_id NULL = the user.
      CREATE TABLE board_cards (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        board_id TEXT NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('todo', 'doing', 'done', 'dropped')),
        position INTEGER NOT NULL,
        due_date TEXT,
        created_by_bot_id TEXT,
        status_changed_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX board_cards_by_board ON board_cards (board_id, status, position);

      CREATE VIRTUAL TABLE board_cards_fts USING fts5 (
        title,
        summary,
        body,
        content = 'board_cards',
        content_rowid = 'seq',
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER board_cards_fts_insert AFTER INSERT ON board_cards BEGIN
        INSERT INTO board_cards_fts (rowid, title, summary, body) VALUES (new.seq, new.title, new.summary, new.body);
      END;
      CREATE TRIGGER board_cards_fts_delete AFTER DELETE ON board_cards BEGIN
        INSERT INTO board_cards_fts (board_cards_fts, rowid, title, summary, body)
          VALUES ('delete', old.seq, old.title, old.summary, old.body);
      END;
      CREATE TRIGGER board_cards_fts_update AFTER UPDATE OF title, summary, body ON board_cards BEGIN
        INSERT INTO board_cards_fts (board_cards_fts, rowid, title, summary, body)
          VALUES ('delete', old.seq, old.title, old.summary, old.body);
        INSERT INTO board_cards_fts (rowid, title, summary, body) VALUES (new.seq, new.title, new.summary, new.body);
      END;

      -- assignee: a bot id or 'user'; bots stay listed after they are deleted (shown as deleted).
      CREATE TABLE board_card_assignees (
        card_id TEXT NOT NULL REFERENCES board_cards (id) ON DELETE CASCADE,
        assignee TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (card_id, assignee)
      );

      CREATE TABLE board_labels (
        id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX board_labels_by_name ON board_labels (board_id, name COLLATE NOCASE);

      CREATE TABLE board_card_labels (
        card_id TEXT NOT NULL REFERENCES board_cards (id) ON DELETE CASCADE,
        label_id TEXT NOT NULL REFERENCES board_labels (id) ON DELETE CASCADE,
        PRIMARY KEY (card_id, label_id)
      );

      -- kind plan/session/design: ref is the id; pr/url: the URL; commit: the sha. state: a PR's last state.
      CREATE TABLE board_card_links (
        id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL REFERENCES board_cards (id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('plan', 'session', 'design', 'pr', 'commit', 'url')),
        ref TEXT NOT NULL,
        label TEXT NOT NULL,
        url TEXT,
        state TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE (card_id, kind, ref)
      );
      CREATE INDEX board_card_links_by_ref ON board_card_links (kind, ref);

      CREATE TABLE board_comments (
        id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL REFERENCES board_cards (id) ON DELETE CASCADE,
        author_type TEXT NOT NULL CHECK (author_type IN ('user', 'bot')),
        author_bot_id TEXT,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX board_comments_by_card ON board_comments (card_id, created_at);

      -- Images of a board's cards (blobs, referenced as asset:<sha> in bodies and comments) and where the VM
      -- has them for bots to read (copied = 0 while the VM was off).
      CREATE TABLE board_images (
        board_id TEXT NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
        sha256 TEXT NOT NULL,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        copied INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (board_id, sha256)
      );

      -- Title + summary vectors of boards and cards (item_id brd_/bcd_), in the knowledge base's vector space.
      CREATE TABLE board_vectors (
        item_id TEXT NOT NULL,
        space TEXT NOT NULL,
        dims INTEGER NOT NULL,
        vector BLOB NOT NULL,
        scale REAL NOT NULL,
        sha256 TEXT NOT NULL,
        PRIMARY KEY (item_id, space)
      );
    `,
} satisfies Migration
