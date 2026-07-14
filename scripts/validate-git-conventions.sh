#!/usr/bin/env sh
set -eu

event="${GITHUB_EVENT_NAME:-local}"
branch="${GITHUB_HEAD_REF:-${GITHUB_REF_NAME:-}}"
title="${PR_TITLE:-}"
body="${PR_BODY:-}"
conventional='^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([a-z0-9._-]+\))?!?: .+'
branch_pattern='^(main|(build|chore|ci|docs|feat|fix|perf|refactor|revert|test)/[a-z0-9]+([._-][a-z0-9]+)*)$'
attribution='(co-authored-by:.*(assistant|bot|chatgpt|claude|codex|copilot|openai|anthropic)|generated (by|with)|written (by|with).*(assistant|chatgpt|claude|codex|copilot|openai|anthropic))'

if [ -n "$branch" ] && ! printf '%s\n' "$branch" | grep -Eq "$branch_pattern"; then
  echo "Invalid branch name: $branch" >&2
  exit 1
fi

if [ "$event" = 'pull_request' ]; then
  if ! printf '%s\n' "$title" | grep -Eq "$conventional"; then
    echo "Pull request title is not a Conventional Commit: $title" >&2
    exit 1
  fi
  if printf '%s\n%s\n' "$title" "$body" | grep -Eiq "$attribution"; then
    echo 'Pull request copy contains prohibited tool attribution' >&2
    exit 1
  fi
fi

before="${GITHUB_EVENT_BEFORE:-}"
if [ "$event" = 'pull_request' ]; then
  range="origin/$GITHUB_BASE_REF..origin/$GITHUB_HEAD_REF"
else
  case "$before" in
    ''|0000000000000000000000000000000000000000) range="$(git rev-list --max-parents=0 HEAD)..HEAD" ;;
    *)
      if git cat-file -e "$before^{commit}" 2>/dev/null; then range="$before..HEAD"
      else range="$(git merge-base HEAD "origin/${GITHUB_BASE_REF:-main}")..HEAD"
      fi
      ;;
  esac
fi

commits="$(git rev-list "$range")"
if [ -z "$commits" ]; then commits="$(git rev-parse HEAD)"; fi
for commit in $commits; do
  subject="$(git show -s --format=%s "$commit")"
  if ! printf '%s\n' "$subject" | grep -Eq "$conventional"; then
    echo "Commit $commit is not conventional: $subject" >&2
    exit 1
  fi
  if git show -s --format=%B "$commit" | grep -Eiq "$attribution"; then
    echo "Commit $commit contains prohibited tool attribution" >&2
    exit 1
  fi
done
