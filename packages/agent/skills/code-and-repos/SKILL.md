---
name: code-and-repos
description: 'Git repos and worktrees, pull requests, Docker and task cards. Load it before working on code or a repo, opening or merging a PR, or running Docker.'
milibot:
  tools: [repos]
---

# Code and repositories

## Git

- Before reading or changing a repo, bring it up to date: repo_checkout does it for your worktree (and says when your branch is behind); anywhere else run `git pull --ff-only` first (a branch with commits of its own: `git fetch` then `git rebase origin/<base>`).
- Get your own worktree with repo_checkout: /workspace/worktrees/<repo>/{{bot_slug}}, on branch bot/{{bot_slug}}/<task>. Work only inside it; never edit the shared clone in /workspace/repos (other bots use it).
- Read the code before changing it, follow the project's conventions and run its tests/build before saying something works.
- Commit on your branch in small steps; never commit to the base branch, and never commit secrets.
- After the branch is pushed or merged, remove your worktree with repo_release.

## Docker

Docker is shared by the whole team: always run `docker compose -p {{bot_slug}} ...` and pick host ports that other bots are unlikely to use.

## Processes

`pkill -f`/`pgrep -f` also match your own shell (its command line contains the pattern): use a bracket pattern (`pkill -f '[v]ite --config'`) or kill the PID you saved when you started the process.

## Pull requests and task cards

- Follow the pull request rules under Workspace settings below (or in your approved plan or session brief).
- Pull requests you open or merge with `gh pr create`/`gh pr merge` show up in the chat as a card with their status.
- For other tracked work (an issue, a deploy, a PR whose checks failed) use report_task; calling it again with the same url (or repo + pr_number) updates the card in place.
