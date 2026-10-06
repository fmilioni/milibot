#!/bin/bash
# Removes worktrees of finished work when nothing in them would be lost: no changes or untracked files (ignored
# ones go, but not another repository inside them outside node_modules), no rebase/merge/cherry-pick/revert/
# bisect going on, no stash of its branch (or of its commit when detached), and every commit of HEAD and of its
# branch on the remote, in a branch or a pull request head (so a squash-merged PR whose branch was deleted still
# counts). A failed fetch keeps everything; `git worktree remove` runs without --force.
# Candidates on stdin, one per line: `<path>|<registered branch>|<policy>`, policy `pr_done` when the pull
# request of its branch was merged or closed, else `-`. A branch goes with its worktree when it has no commits
# of its own against the base, or when `pr_done` and all of it is on the remote.
# Prints FETCH=failed when it applies, then per candidate `RESULT=<path>|<outcome>|<branch>|<branch deleted>`:
# outcome `removed`, `gone` (no such folder) or `kept:<reason>`; branch = the one checked out ('' = detached).
# Env: REPO_NAME, BASE_BRANCH ('' = origin's default).
set -uo pipefail
git config --global --replace-all safe.directory '*'
REPO_DIR="/workspace/repos/$REPO_NAME"
ROOT="/workspace/worktrees/"
PR_REFS="refs/milibot/pull"
CANDIDATES=$(cat)

result() { echo "RESULT=$1|$2|${3:-}|${4:-0}"; }

keep_all() {
  local path
  while IFS='|' read -r path _; do
    [ -n "$path" ] && result "$path" "kept:$1"
  done <<<"$CANDIDATES"
  exit 0
}

if [ ! -d "$REPO_DIR/.git" ] || ! cd "$REPO_DIR"; then keep_all no_repo; fi
COMMON=$(cd .git && pwd -P)

# Pull request heads (`refs/pull/<n>/head`) whose commits are already here become refs, so their commits count
# as pushed; fetching every one of them could download a lot in a big repository.
sync_pr_refs() {
  local listing
  listing=$(git ls-remote origin 'refs/pull/*/head') || return 1
  git for-each-ref --format='delete %(refname)' "$PR_REFS/" | git update-ref --stdin || return 1
  [ -n "$listing" ] || return 0
  awk '{ print $1 }' <<<"$listing" | git cat-file --batch-check='%(objectname) %(objecttype)' |
    paste -d' ' - <(awk '{ print $2 }' <<<"$listing") |
    awk -v prefix="$PR_REFS" '$2 == "commit" { split($3, p, "/"); print "create " prefix "/" p[3] " " $1 }' |
    git update-ref --stdin
}

if ! git fetch --quiet --prune origin </dev/null || ! sync_pr_refs; then
  echo "warning: fetch failed" >&2
  echo "FETCH=failed"
  keep_all fetch_failed
fi
BASE="$BASE_BRANCH"
[ -n "$BASE" ] || BASE=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)

# Commits of the refs given that are on no remote branch and in no pull request head.
unpushed() { git rev-list --count "$@" --not --remotes --glob="$PR_REFS/*" 2>/dev/null; }

# A stash of the worktree's branch, or, for a detached worktree, one made in detached HEAD on its commit (stashes
# live in the repository and stay; this keeps work parked for the worktree from being forgotten).
has_stash() {
  local branch=$1 head=$2 subject parents
  while IFS=$'\t' read -r subject parents; do
    if [ -n "$branch" ]; then
      case "$subject" in "WIP on $branch:"* | "On $branch:"*) return 0 ;; esac
    else
      case "$subject" in "WIP on (no branch):"* | "On (no branch):"*)
        [ "${parents%% *}" = "$head" ] && return 0 ;;
      esac
    fi
  done < <(git stash list --format='%gs%x09%P' 2>/dev/null)
  return 1
}

in_progress() {
  local dir
  dir=$(git -C "$1" rev-parse --absolute-git-dir) || return 0
  for f in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG; do
    [ -e "$dir/$f" ] && return 0
  done
  return 1
}

# Why the worktree must stay, or nothing when it can go.
keep_reason() {
  local path=$1 branch=$2 head=$3 common count
  common=$(cd "$path" && cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P) || common=''
  [ "$common" = "$COMMON" ] || { echo not_worktree; return; }
  [ -n "$head" ] || { echo no_head; return; }
  in_progress "$path" && { echo in_progress; return; }
  [ -z "$(git -C "$path" status --porcelain 2>/dev/null || echo error)" ] || { echo dirty; return; }
  # Another repository inside an ignored folder may hold commits of its own (dependencies aside).
  [ -z "$(find "$path" \( -name node_modules -o -path "$path/.git" \) -prune -o -name .git -print -quit 2>/dev/null)" ] ||
    { echo nested_repo; return; }
  has_stash "$branch" "$head" && { echo stash; return; }
  count=$(unpushed "$head" ${branch:+"refs/heads/$branch"}) || { echo unknown; return; }
  [ "$count" = 0 ] || echo unpushed
}

# Whether a branch can go: none of its commits are its own against the base, or its pull request is done and
# all of it is on the remote.
branch_done() {
  local branch=$1 done_pr=$2
  [ -n "$branch" ] && [ "$branch" != "$BASE" ] || return 1
  git show-ref --verify --quiet "refs/heads/$branch" || return 1
  if [ -n "$BASE" ] && git show-ref --verify --quiet "refs/remotes/origin/$BASE" &&
    [ "$(git rev-list --count "refs/heads/$branch" --not "refs/remotes/origin/$BASE")" = 0 ]; then
    return 0
  fi
  [ "$done_pr" = 1 ] && [ "$(unpushed "refs/heads/$branch")" = 0 ]
}

while IFS='|' read -r path registered policy <&3; do
  [ -n "$path" ] || continue
  case "$path" in
    *..*) result "$path" kept:outside "$registered"; continue ;;
    "$ROOT"?*) ;;
    *) result "$path" kept:outside "$registered"; continue ;;
  esac
  if [ ! -e "$path" ]; then
    result "$path" gone "$registered"
    continue
  fi
  branch=$(git -C "$path" branch --show-current 2>/dev/null || true)
  head=$(git -C "$path" rev-parse --verify --quiet HEAD 2>/dev/null || true)
  reason=$(keep_reason "$path" "$branch" "$head")
  if [ -n "$reason" ]; then
    result "$path" "kept:$reason" "$branch"
    continue
  fi
  if ! git worktree remove "$path" >/dev/null 2>&1; then
    result "$path" kept:remove_failed "$branch"
    continue
  fi
  deleted=0
  if branch_done "$branch" "$([ "$policy" = pr_done ] && echo 1)" && git branch -D --quiet "$branch" >/dev/null 2>&1; then
    deleted=1
  fi
  # The branch the worktree was made on, when the work moved to another one (a pull request checked out).
  if [ "$registered" != "$branch" ] && branch_done "$registered" ''; then
    git branch -D --quiet "$registered" >/dev/null 2>&1 || true
  fi
  result "$path" removed "$branch" "$deleted"
done 3<<<"$CANDIDATES"
git worktree prune
