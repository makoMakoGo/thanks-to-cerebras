#!/usr/bin/env sh
set -eu

upstream_remote="${UPSTREAM_REMOTE:-origin}"
fork_remote="${FORK_REMOTE:-git@github.com-lovingfish:lovingfish/thanks-to-cerebras.git}"
branch="${BRANCH:-main}"

current_branch="$(git branch --show-current)"
if [ "$current_branch" != "$branch" ]; then
  echo "Refusing to publish: current branch is '$current_branch', expected '$branch'." >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "Refusing to publish: working tree is not clean." >&2
  exit 1
fi

git push "$upstream_remote" "refs/heads/$branch:refs/heads/$branch"
git push "$fork_remote" "refs/heads/$branch:refs/heads/$branch"
