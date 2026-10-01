# Contributing

Issues and pull requests are welcome. For anything larger than a small fix, open an issue first so we can
agree on the approach.

## Development

See the README for requirements and `pnpm dev`. Before opening a pull request, run:

```bash
pnpm check                  # typecheck, lint, format check, unit and integration tests
pnpm knip                   # unused files, exports and dependencies
pnpm check:migrations main  # at most one new migration per database
```

CI runs the same checks on every pull request.

## Conventions

- Code, identifiers, logs, comments and model-facing text are in English. User-facing strings go in
  `apps/desktop/src/renderer/src/i18n/locales/` (pt-BR and en, same keys).
- Prettier style: no semicolons, single quotes, width 110.
- A database schema change is a new migration, at most one per pull request per database; never edit one
  already on `main` (details in `apps/daemon/CLAUDE.md`).
- `CLAUDE.md` files (root and per package) hold the codebase map and its known pitfalls.

## Pull requests

- Pull requests are **squash-merged**, and the **PR title becomes the commit message**. The title must follow
  [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`, e.g.
  `fix(desktop): keep the search icon inside padded inputs`. A check validates it.
- Releases are cut from these messages: `feat` → minor, `fix`/`perf` → patch, `!` or a `BREAKING CHANGE:`
  footer → major. `docs`, `test`, `refactor`, `chore`, `ci`, `build` and `style` don't appear in the
  changelog. Write the summary for the changelog: user-facing, imperative, no trailing period.
- Scopes are optional and name the area: `daemon`, `agent`, `desktop`, `shared`, `vm`, `ci`, `deps`, `release`
  (the full list is in `.github/workflows/pr-title.yml`).

By contributing you confirm that you have the right to submit your contribution, you grant Felipe Milioni a
perpetual, worldwide, non-exclusive, royalty-free, irrevocable copyright and patent license to use, modify,
sublicense and distribute it under any terms, including the project's license (see `LICENSE.md`), and you
follow the [code of conduct](CODE_OF_CONDUCT.md).
