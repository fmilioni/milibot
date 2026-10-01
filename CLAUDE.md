# Milibot

Teams of AI bots operating a shared Debian VM. These files map the code and its pitfalls; details live in the code and tests.

```
apps/daemon     milibotd: supervisor (Fastify + WS) + 1 runtime process per workspace + 1 process per local embedding model
apps/desktop    Electron (main/preload/renderer) — React 19, Zustand, TanStack Query, i18next, Tailwind v4; packaging (scripts/package/)
packages/shared types, zod schemas, HTTP routes, WS events, typed HTTP client, pure logic used by daemon and app
packages/agent  LLMProvider, AgentHost (turns, lanes, context/memory), tools, prompts, CLI engines (Claude Code, Codex), built-in skills
vm/             golden image, provision.sh + provision.d/, host CLIs (vm/host: VM lifecycle, golden build), guest agent
```

## Tests

- **Unit** (`*.test.ts`): SQLite `:memory:`, no disk, no setup; includes `vm/guest-agent/test` and `vm/host/test`. The renderer's `*.test.tsx` run in the `dom` project (happy-dom), part of `pnpm test:unit`.
- **Integration** (`*.int.test.ts`): no setup. Each test makes its data dir with `mkdtemp` under `os.tmpdir()` (`TMPDIR` decides where they write). The Vitest `integration` project sets `MILIBOT_SECRET_STORE=memory`, `MILIBOT_VM_DISABLED=1` (never a real VM) and `MILIBOT_FAKE_EMBEDDINGS=1`.
- Fakes: `apps/daemon/test/support/`, `packages/agent/src/test-support/` (`@milibot/agent/testing`).
- CI (`.github/workflows/ci.yml`, Linux, on PRs and pushes to main): everything `pnpm check` runs plus shellcheck, `pnpm knip`, `pnpm check:migrations` and the build; actions pinned by SHA, Node from `.nvmrc`. Other OSes and the VM E2E run only by hand.

```bash
pnpm check              # typecheck + lint + format:check + test (unit + integration)
pnpm test:unit
pnpm test:integration
pnpm lint               # includes vm/; type-aware rules (floating promises) and import sorting
pnpm format             # prettier --write .
pnpm knip               # unused files, exports and dependencies in every package
```

## Running

- Node 24 (nvm) + pnpm through corepack. No dependency needs a C++ toolchain: `better-sqlite3` loads the N-API prebuilds it ships, so its implicit node-gyp build stays ignored in `pnpm-workspace.yaml` (allowing it breaks Windows installs without Visual Studio). Electron has no install script: its binary is downloaded by `install-electron`, which the desktop `dev`/`preview` scripts and `pnpm package` run.
- `pnpm dev` = daemon under `tsx watch` + Electron with `MILIBOT_DAEMON_EXTERNAL=1`. `pnpm dev:desktop` alone starts the daemon **detached** from sources (log at `<dataRoot>/logs/daemon.log`); it keeps running after the app closes (by design).
- `pnpm build` = `apps/daemon/dist/*.js` (esbuild; native addons external) + `apps/desktop/out/`.
- **Manual app run**: `MILIBOT_DATA_DIR=$D/devdata MILIBOT_SECRET_STORE=memory pnpm dev` (`D` = your own scratch dir). Opening a workspace boots its VM (~8 GB of RAM) unless `MILIBOT_VM_AUTOSTART=0`.
- **Real verification with a VM**: own scratch dir `D` (~10 GB free; never touch another agent's). The golden is still looked up in the default data root, so one must exist there. Start the daemon from an entry file in `$D`, so another agent's `pkill -f src/main.ts` won't kill it; `$D` has no `node_modules`, so tsx is loaded by absolute path (run from the repo root):

  ```bash
  echo "import '$PWD/apps/daemon/src/main.ts'" > $D/daemon.mjs
  MILIBOT_DATA_DIR=$D/data MILIBOT_SECRET_STORE=memory MILIBOT_VM_PORT_FIRST=47600 MILIBOT_FAKE_LLM=$D/script.json \
    node --import "file://$PWD/apps/daemon/node_modules/tsx/dist/loader.mjs" $D/daemon.mjs
  ```

  Open a workspace through the API, wait for `GET /w/:ws/vm` = `running`, post to a bot's DM. The script is a JSON array of `FakeStep` (`{text?, toolCalls?: [{name, arguments}]}`), read once per process. A workspace created through the API has setup done, so the first bot's intro turn takes the first step: put an intro step first. At the end: `POST /w/:ws/vm/stop`, kill the daemon, remove `$D`.

| Variable                                           | Use                                                                                                      |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `MILIBOT_DATA_DIR`                                 | data root (default `defaultDataRoot`; `MILIBOT_HOME` for the VM scripts)                                 |
| `MILIBOT_SECRET_STORE`                             | `memory` (tests/dev), `keychain`, `keyring`, `file`; unset = Keychain on macOS, probed keyring elsewhere |
| `MILIBOT_DAEMON_PORT`                              | supervisor port (default: the previous `daemon.json` port or random)                                     |
| `MILIBOT_DAEMON_EXTERNAL=1`                        | Electron doesn't spawn the daemon, only waits for it                                                     |
| `MILIBOT_LOG_LEVEL`, `MILIBOT_LOG_REQUESTS=1`      | daemon logs (pino JSON)                                                                                  |
| `MILIBOT_VM_DISABLED=1`                            | runtime without a VM                                                                                     |
| `MILIBOT_VM_AUTOSTART=0`                           | don't boot the VM on open (a running VM is still adopted)                                                |
| `MILIBOT_VM_PORT_FIRST`                            | first VM port for new workspaces (default below every OS's ephemeral range; blocks of 100)               |
| `MILIBOT_GOLDEN_IMAGE`                             | force the golden image (the only one considered; a missing file tests "golden missing")                  |
| `MILIBOT_VM_CLI` / `MILIBOT_VM_BUILD`              | replace the VM CLI / golden build (see below)                                                            |
| `MILIBOT_QEMU_SHARE`                               | QEMU's data folder (UEFI firmware) when it isn't next to the binary                                      |
| `MILIBOT_BUILTIN_SKILLS` / `MILIBOT_DESIGN_ASSETS` | built-in skills folder / design compiler assets (default: found next to the code)                        |
| `MILIBOT_FAKE_EMBEDDINGS=1`                        | deterministic embeddings (no model download)                                                             |
| `MILIBOT_FAKE_IMAGES=1`                            | `generate_image` draws solid PNGs (an image model must still be registered)                              |
| `MILIBOT_FAKE_LLM=<script.json>`                   | every provider becomes a scripted `FakeProvider` (see below)                                             |

- `MILIBOT_VM_CLI`/`MILIBOT_VM_BUILD` replace `vm/host/src/cli/workspace-vm.ts`/`build-golden.ts`: `.ts`/`.mjs`/`.js` run with the daemon's Node; a `.sh` fake printing the same lines runs on bash.
- `MILIBOT_FAKE_LLM` script: a step with `when` answers only a request whose system prompt contains it (e.g. `DRAW_PROMPT_MARKER` for design_draw's side call); `pieceDelayMs` streams its text slowly.

## Cross-package rules

- **Routes**: `api` (`shared/src/http/api.ts`) joins every domain's endpoint map (how to add one: `packages/shared/CLAUDE.md`); the supervisor registers them by iterating it and validates input only from `api[endpoint]` (`parseEndpointInput`). App routes are implemented in `apps/daemon/src/supervisor/`; workspace routes (`/w/:workspaceId/…`) in the `handlers()` of the owning runtime service or its domain's `<Domain>Routes`, merged by `collectHandlers` (`runtime/composition/container.ts`), which throws on an endpoint served twice.
- **WS events**: `/events` (app) and `/w/:ws/events` (workspace), envelope `{seq, at, workspaceId, event}`, schemas in `shared/src/events/events.ts`.
- **Model choice** (`shared/src/models/reasoning.ts`): every place that picks a model (bot columns, `ModelChoice` preferences, `work_sessions`/`plans.model_spec`, a helper's `TurnRequest.model`) carries the same tuning: `effort` (`ReasoningEffort`; `effort` alone in `BotStatus` means "struggling", unrelated), `contextLimit`, `maxOutputTokens`; null = the model's default.
  - Models declare the efforts they accept (`provider_models.efforts`, the engines' catalogs in `CLI_ENGINE_INFO`, Anthropic's built-in catalog) and `pickEffort` narrows a request to them, so a choice never fails for an unsupported level.
  - A level is a standard one (`REASONING_EFFORTS`, ranked) or a server's own value registered on the model (`ReasoningEffort` is a string): custom levels are sent as is, only match exactly, and the Anthropic provider drops them.
  - Side work on the bot's own model (summaries, triage) drops its effort and cap and runs at `low`, except `design_draw`, which draws on the lane's model at `high` (`forDrawing`, `model-policy.ts`).
- **Messages** (`shared/src/chat/messages.ts`): `kind` picks the renderer (`text`, `activity`, `card`, `system_event`), `payload.type` the data; `content` is always the text fallback (and, in cards like `routine_run`/`session_brief`, what the bot reads). New card: zod payload in the `MessagePayload` union, parser in the renderer's `features/chat/lib/message-view.ts`, a component in `features/chat/cards/` rendered from `features/chat/MessageBody.tsx`, preview in `features/chat/lib/message-preview.ts`, i18n.
- **New tool, end to end**:
  - agent: definition, activity step (`describe`) and label in its family file (`agent/src/tools/families/<family>.ts`); a new family is also listed in `tools/catalog.ts` and, when skill-gated, in `TOOL_FAMILIES` (`tools/policy.ts`). Skill-gated families keep terse definitions: parameter meanings go in the family skill's "Tool reference" section.
  - shared: the kind in `ACTIVITY_STEP_KINDS` (`shared/src/chat/activity-kinds.ts`).
  - desktop: icon/text in `features/chat/lib/activity-steps.ts` and i18n `chat.activity.kinds.<kind>` and `<kind>_empty` (tests enforce it).
  - daemon: execution in the family's tools object (`<domain>/tools.ts`, a `ToolSwitch`); a new family is registered in the runtime's `ToolRegistry`, which refuses to start unless every catalog tool has exactly one owner. The daemon imports the families from `@milibot/agent/tools`, never re-declares tool names.
- **Tool gating invariant**:
  - A built-in skill's `milibot.tools` lists families (`TOOL_FAMILIES`); a family is dropped only while every built-in declaring it is inactive for the bot. `SETTING_FAMILIES` (`web_search`, `image_generation`) are declared by no skill and dropped while their setting is off (search key; an enabled image model), in the runtime's `skillContext` (`runtime/composition/container.ts`).
  - `env.skillContext(bot)` gives catalog + families, and the same set must reach `toolsForLane` (API host), `cliPrompt`, the MCP server (`enabledFamilies`) and the host's tool gate (`agent/src/host/tools/tool-gate.ts`). Lane rules keep `todo_write` in session lanes.
  - `team-management` has `milibot.default: first`: off for every bot without an explicit `bot_skill_prefs` row (`seedWorkspace` writes the first bot's), never re-evaluated live. `add_member`/`remove_member` are outside every family and follow the group's `botsCanManageMembers` (a bot with `team` active manages any group).
  - The PR rules (`pullRequestNote`) are appended when `code-and-repos` is loaded (not in the system prompt) and also go in a plan's execution note and the session brief with the plan's merge choice (`plans.merge_pr`, NULL = `git.auto_merge_prs`).
- **First bot** (`shared/src/bots/first-bot.ts`, `store.firstBot()`): no bot is special; the oldest active bot (`created_at, id`) gets the seeded persona and `team-management` switch and is the default target of everything that needs one bot (intro, setup's login display, spend card, triage fallback, default chat). Any bot can be deleted, except the last one or by itself through the tool (`BotStore.assertDeletable`).
- **CLI engines** (`CliEngine` = `claude_code` | `codex`, `CLI_ENGINES`/`isCliEngine` in `shared/src/models/cli.ts`): providers whose bots run as a coding CLI in the VM as `agent`, one process per lane, reaching Milibot's tools through its MCP server with a token per lane and engine.
  - Engine-specific code lives only in the agent's `CliEngineDriver` (`CLI_ENGINE_DRIVERS`, `agent/src/cli/registry.ts`) and the daemon's `CliEngineHost` (`CLI_ENGINE_HOSTS`); other code goes through them (`ResolvedModel` `{kind: 'cli', engine}`, `env.cli[engine]`) or reads `CLI_ENGINE_INFO` (`shared/src/models/cli.ts`: brand names, catalog, default/light model, auth modes, capabilities). What engines share is named `cli`/`Cli*`; only engine-specific code carries an engine's name. Engine state lives under `cliKeys(engine)` (`claude_code.*`, `codex.*`).
  - The app branches on no engine id and reaches engines only through the generic routes `/w/:ws/cli/:engine/*` (an engine without the capability answers `unsupported`).
  - Error cards use `cli_error|cli_usage_limit|cli_unavailable|cli_login_required` with `params.engine` (read with `cliErrorOf`).
  - **Adding an engine**: (1) `packages/agent/src/<engine>/` + its `CLI_ENGINE_DRIVERS` line and harness in `cli/engine-contract.test.ts`; (2) `apps/daemon/src/runtime/providers/cli-engines/<engine>.ts` + its `CLI_ENGINE_HOSTS` line; (3) its `CLI_ENGINE_INFO` entry, the `ProviderType`/`CLI_ENGINES` value and `settings.providers.cli.<engine>.note`. The desktop needs no other change.
- **User language**: the workspace preference `user.language` (written by `seedWorkspace` on every runtime start, pushed to running runtimes by `updateAppSettings`) reaches the prompt through `env.userLanguage()`.
- **Secrets**: never in SQLite, messages, logs or tool results; `llm_calls`/`tool_calls`/tool results/messages go through `redactSecrets` (`@milibot/shared`).
- **Windows**: every spawn/execFile/fork in the daemon, the desktop main process and the VM scripts passes `windowsHide` (`windows-hide.test.ts` scans the sources).
- Settings keys read by more than one package live in `shared/src/core/settings-keys.ts`. `shared/src/portable/` also runs in the VM host CLIs and the guest agent: erasable syntax only, no imports outside `portable/` (lint).

## Conventions

- Code, identifiers, logs and error codes in English; comments in English and only when non-obvious.
- **No hardcoded UI strings**: `apps/desktop/src/renderer/src/i18n/locales/{pt-BR,en}/` (pt-BR is the default; a test checks keys and placeholders). Plain-language terms (no "BYOK", "fallback"). The daemon returns error codes + params (English `error` as fallback) and the app translates them; the only pt-BR text outside the locales is what shows outside the renderer or is seeded into a workspace (main-process `i18n.ts`, first bot persona, recorded procedure steps, the OAuth result page).
- **Portuguese** is allowed only in the locales, text shown outside the renderer or seeded into a workspace, deliberate pt logic (phrase parser, stopwords, aliases) and tests/fixtures of pt features; incidental pt sample text gets translated. `test/language-guard.test.ts` scans every file git knows except the locales and requires a `// Portuguese on purpose: <why>` marker (or `#`/`<!-- -->`) in each file that matches; a marker without a reason, or in a file with no match, fails.
- **Stored names**: `slugify`/`foldText` (`shared/src/core/text.ts`) produce stored slugs and file names; `text.test.ts` pins literal outputs, never change them. Host writes of names from the VM, imports or the database go through `hostSafeName`/`containedJoin` (`apps/daemon/src/util/safe-path.ts`).
- Every schema change needs a new migration, at most one per PR per database; never edit one already on `main` (`apps/daemon/CLAUDE.md`).
- Timestamps in epoch ms. IDs: `newId('<kind>')` → `prefix_<ulid>`.
- TypeScript strict (`noUncheckedIndexedAccess`), ESM. `shared`/`agent` consumed as TS source. Prettier: no semicolons, single quotes, width 110.
- PRs are squash-merged, so the **PR title is the commit message**: a Conventional Commit (`type(scope): subject`, scopes as listed in `pr-title.yml`, which checks it). The subject is the changelog line (user-facing, imperative, no trailing period); `feat`/`fix`/`perf`/`revert` release, other types don't. One logical change per PR. Details in `CONTRIBUTING.md`.
- When a feature is done, update the CLAUDE.md of the area you touched (this file only for cross-package rules) with what can't be learned by reading the code (where it lives, invariants, pitfalls); no route lists, UI copy or measurements. Keep it in English.
- Don't commit/push unless the user asks.
