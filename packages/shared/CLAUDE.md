# @milibot/shared

The wire contract between the daemon, the desktop app and `@milibot/agent` (zod schemas, routes, events, the
typed client) plus pure logic used by at least two packages. Logic only one package uses lives in that
package. Consumed as TS source through `@milibot/shared` (the root `index.ts` re-exports every folder's
`index.ts`); only `portable/*` has its own subpath export.

## Layout

One folder per domain (`workspace/`, `bots/`, `chat/`, `models/`, `work/`, `designs/`, `boards/`, `routines/`,
`knowledge/`, `memory/`, `skills/`, `procedures/`, `mcp/`, `credentials/`, `vm/`, `costs/`, `debug/`), plus:

- `http/`: `endpoint()`/`defineApi()`, the assembled `api`, errors and their HTTP status, path params, the
  typed client, `daemon.json`.
- `events/`: WebSocket events and envelopes.
- `core/`: ids, text helpers, line diffs, secret redaction (`redactSecrets`), small cross-domain schemas
  (`AuthorType`, `Progress`) and the settings keys registry.
- `portable/`: see below.

Tests sit next to their module. Inside the package import the file itself (`../chat/messages`), never a
folder `index.ts`: zod schemas are built at module load, so an import cycle through an index fails at
runtime (`bots/endpoints.ts` and `chat/user-request-endpoints.ts` exist only to keep such cycles out).

## Routes

A domain file declares its `<domain>Endpoints` map with `endpoint()`; `http/api.ts` passes every map to
`defineApi`, which throws at load on a name or method + path declared twice. Paths under `/w/:workspaceId`
are workspace routes (forwarded to the runtime); anything else is an app route of the supervisor. A `params`
schema narrows path params (e.g. `engine` to `CLI_ENGINES`): the daemon validates it and the typed client
and handlers see the narrowed type. Request schemas used only by their endpoint stay unexported
(`api.x.body`/`api.x.query` expose them); exported request types are `z.input` (what callers send), the
daemon reads the parsed ones (`Parsed<>`).

## Settings keys

`core/settings-keys.ts` holds every `settings` table key more than one package touches: `*_SETTING_KEYS`
objects (field → key, so a body maps onto them) and `*_KEY` single keys. A group may reuse a
`PREFERENCE_SETTING_KEYS` key; any other duplicate fails `settings-keys.test.ts`. Keys private to one package
(daemon state such as `seed.version`, the agent's `AGENT_SETTING_KEYS`/`HOST_STATE_KEYS`) stay there.

## portable/

Loaded by the host CLIs (`vm/host`, plain Node type stripping, which refuses `.ts` under `node_modules`)
through relative paths and by the guest agent through `@milibot/shared/portable/*`. Only erasable syntax
(`erasableSyntaxOnly`) and no imports outside `portable/` (ESLint `no-restricted-imports`); a portable file
importing another must spell the `.ts` extension for plain Node (`index.ts` serves only the package).
`vm/vm-cli.ts` (zod) is the daemon ↔ VM CLI contract; the CLIs import only its types. Browser globals are
banned in the whole package (`no-restricted-globals`); the `DOM` lib stays only for `fetch`/`Response` types.
