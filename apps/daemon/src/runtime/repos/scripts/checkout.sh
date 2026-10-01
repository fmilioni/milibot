#!/bin/bash
# Clones the repository once into /workspace/repos/<name> (the shared clone), fetches, fast-forwards the shared
# clone and a clean reused worktree, or adds the worktree. Prints KEY=VALUE lines: STATUS, BASE, BRANCH, and
# FETCH=failed, DIRTY=1, BEHIND=<n> when they apply.
# Env: REPO_URL ('' = already cloned), REPO_NAME, BOT_SLUG, BRANCH, BASE_BRANCH ('' = origin's default),
# WT_PATH (optional), GIT_NAME, GIT_EMAIL.
set -euo pipefail
git config --global --replace-all safe.directory '*'
git config --global user.name "$GIT_NAME"
git config --global user.email "$GIT_EMAIL"
REPO_DIR="/workspace/repos/$REPO_NAME"
WT=$(printenv WT_PATH || true)
[ -n "$WT" ] || WT="/workspace/worktrees/$REPO_NAME/$BOT_SLUG"
mkdir -p /workspace/repos "/workspace/worktrees/$REPO_NAME" "$(dirname "$WT")"
if [ ! -d "$REPO_DIR/.git" ]; then
  if [ -z "$REPO_URL" ]; then echo "repository $REPO_NAME is not cloned yet; pass its URL" >&2; exit 3; fi
  git clone --quiet "$REPO_URL" "$REPO_DIR"
fi
cd "$REPO_DIR"
git fetch --quiet --prune origin || { echo "warning: fetch failed" >&2; echo "FETCH=failed"; }
clean() { [ -z "$(git -C "$1" status --porcelain --untracked-files=no)" ]; }
# The shared clone is what bots read before they have a worktree: keep its branch on its upstream.
if clean "$REPO_DIR"; then git merge --ff-only --quiet '@{u}' >/dev/null 2>&1 || true; fi
BASE="$BASE_BRANCH"
if [ -z "$BASE" ]; then
  BASE=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)
  [ -n "$BASE" ] || BASE=$(git branch --show-current)
fi
if [ -d "$WT" ] && git -C "$WT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "STATUS=reused"
  if clean "$WT"; then
    git -C "$WT" merge --ff-only --quiet '@{u}' >/dev/null 2>&1 || true
    if git rev-parse --verify --quiet "refs/remotes/origin/$BASE" >/dev/null; then
      git -C "$WT" merge --ff-only --quiet "origin/$BASE" >/dev/null 2>&1 || true
    fi
  else
    echo "DIRTY=1"
  fi
  if git rev-parse --verify --quiet "refs/remotes/origin/$BASE" >/dev/null; then
    echo "BEHIND=$(git -C "$WT" rev-list --count "HEAD..origin/$BASE")"
  fi
else
  git worktree prune
  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git worktree add --quiet "$WT" "$BRANCH"
  elif git show-ref --verify --quiet "refs/remotes/origin/$BASE"; then
    git worktree add --quiet -b "$BRANCH" "$WT" "origin/$BASE"
  else
    git worktree add --quiet -b "$BRANCH" "$WT" "$BASE"
  fi
  echo "STATUS=created"
fi
echo "BASE=$BASE"
echo "BRANCH=$(git -C "$WT" branch --show-current)"
