#!/usr/bin/env sh
set -eu
for path in README.md CHANGELOG.md LICENSE CONTRIBUTING.md SECURITY.md CODE_OF_CONDUCT.md docs/notifyhub-engineering-doc.md docs/IMPLEMENTATION_PLAN.md docs/MILESTONES.md docs/DECISIONS.md docs/PROGRESS.md; do
  test -f "$path" || { echo "Missing required file: $path"; exit 1; }
done
grep -q '^sample/$' .gitignore
echo 'Governance verification passed.'
if test -f package.json; then
  npm run verify
fi
