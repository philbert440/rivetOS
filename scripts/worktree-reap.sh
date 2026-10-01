#!/usr/bin/env bash
# worktree-reap.sh — remove git worktrees whose work has landed.
#
# Review rounds and agent sessions create worktrees (wt-pr-NNNN, w-<topic>) and
# nothing removed them; an audit on 2026-09-30 found ~200 of them (~25 GB).
# This is the post-merge cleanup step of the review workflow.
#
# A worktree is reaped when ALL of these hold:
#   - it is not the main checkout;
#   - `git status --porcelain` is empty apart from ignored build output
#     (dist/, node_modules/ lines);
#   - its branch has a PR that is MERGED or CLOSED (via `gh`); or it is
#     detached and its HEAD is an ancestor of origin/main; or it is a review
#     checkout named wt-pr-NNNN / w-pr-NNNN, PR NNNN is MERGED/CLOSED and
#     HEAD is one of that PR's commits (squash merges leave them off main).
#     Ancestry alone is never enough for a branch, so PR state is the test;
#   - no running process has its cwd under it.
# Everything else is skipped and listed. Dry run by default.
#
# Usage: scripts/worktree-reap.sh [--repo <main checkout>] [--apply]
#                                 [--keep-branches] [--no-fetch]
set -euo pipefail

repo="$(git rev-parse --show-toplevel 2>/dev/null || true)"
apply=0
keep_branches=0
do_fetch=1
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="$2"; shift 2 ;;
    --apply) apply=1; shift ;;
    --keep-branches) keep_branches=1; shift ;;
    --no-fetch) do_fetch=0; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$repo" ] || { echo "not inside a git repo; pass --repo" >&2; exit 2; }
command -v gh >/dev/null || { echo "gh is required (PR state is the merge test)" >&2; exit 2; }

if [ "$do_fetch" = 1 ]; then git -C "$repo" fetch -q origin main 2>/dev/null || true; fi

main_wt="$(git -C "$repo" rev-parse --show-toplevel)"
reaped=0; skipped=0; freed=0
declare -a branches_to_delete=()

say() { printf '%s\n' "$*"; }
in_use() { # any process with cwd under $1
  local d="$1" p
  for p in /proc/[0-9]*; do
    case "$(readlink "$p/cwd" 2>/dev/null || true)" in "$d"|"$d"/*) return 0 ;; esac
  done
  return 1
}
dirty() { # porcelain lines other than ignored build output
  git -C "$1" status --porcelain 2>/dev/null | grep -vE '^(\?\?|!!) (.*/)?(dist|node_modules)/' | grep -q .
}
pr_number_from_name() { # wt-pr-1234 / w-pr-1234 -> 1234
  basename "$1" | sed -nE 's/^(wt|w)-pr-?([0-9]+)$/\2/p'
}
head_in_pr() { # $1 = PR number, $2 = sha: PR merged/closed and sha is one of its commits
  local st shas
  st="$(gh pr view "$1" --json state -q .state 2>/dev/null || true)"
  case "$st" in MERGED|CLOSED) ;; *) return 1 ;; esac
  shas="$(gh pr view "$1" --json commits -q '.commits[].oid' 2>/dev/null || true)"
  printf '%s\n' "$shas" | grep -qx "$2"
}
pr_state() { # branch -> MERGED|CLOSED|OPEN|NONE
  local st
  st="$(gh pr list --repo "$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)" \
        --state all --head "$1" --json state -q '.[0].state' 2>/dev/null || true)"
  printf '%s' "${st:-NONE}"
}

while IFS= read -r line; do
  case "$line" in
    worktree\ *) wt="${line#worktree }"; branch=""; detached=0 ;;
    branch\ *) branch="${line#branch refs/heads/}" ;;
    detached) detached=1 ;;
    "")
      [ -n "${wt:-}" ] || continue
      if [ "$wt" = "$main_wt" ]; then wt=""; continue; fi
      if [ ! -d "$wt" ]; then say "prune   $wt (directory gone)"; wt=""; continue; fi
      reason=""
      if dirty "$wt"; then reason="dirty"
      elif in_use "$wt"; then reason="in use by a running process"
      elif [ -n "$branch" ]; then
        st="$(pr_state "$branch")"
        case "$st" in
          MERGED|CLOSED) reason="" ;;
          OPEN) reason="PR open" ;;
          *) reason="no PR for branch $branch" ;;
        esac
      else
        head_sha="$(git -C "$wt" rev-parse HEAD)"
        prnum="$(pr_number_from_name "$wt")"
        if git -C "$repo" merge-base --is-ancestor "$head_sha" origin/main 2>/dev/null; then reason=""
        elif [ -n "$prnum" ] && head_in_pr "$prnum" "$head_sha"; then reason=""
        else reason="detached HEAD not on origin/main${prnum:+ and PR #$prnum not merged/closed}"; fi
      fi
      if [ -n "$reason" ]; then say "skip    $wt ($reason)"; skipped=$((skipped+1)); wt=""; continue; fi
      size="$(du -sk "$wt" 2>/dev/null | cut -f1)"; freed=$((freed+size))
      if [ "$apply" = 1 ]; then
        git -C "$repo" worktree remove --force "$wt" && say "removed $wt (${branch:-detached}, $((size/1024)) MB)"
        [ -n "$branch" ] && [ "$keep_branches" = 0 ] && branches_to_delete+=("$branch")
      else
        say "would   $wt (${branch:-detached}, $((size/1024)) MB)"
      fi
      reaped=$((reaped+1)); wt=""
      ;;
  esac
done < <(git -C "$repo" worktree list --porcelain; echo)

if [ "$apply" = 1 ]; then
  git -C "$repo" worktree prune
  for b in "${branches_to_delete[@]:-}"; do
    [ -n "$b" ] || continue
    git -C "$repo" branch -D "$b" >/dev/null 2>&1 && say "branch  deleted $b" || say "branch  kept $b (still checked out elsewhere?)"
  done
  git -C "$repo" remote prune origin >/dev/null 2>&1 || true
fi
say "---"
say "$([ "$apply" = 1 ] && echo reaped || echo reapable): $reaped  skipped: $skipped  $((freed/1024)) MB$([ "$apply" = 1 ] || echo ' (dry run; add --apply)')"
