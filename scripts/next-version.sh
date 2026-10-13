#!/usr/bin/env bash
# Prints the next release version from Conventional Commits since the last vX.Y.Z tag:
# "type!:" or "BREAKING CHANGE" → major, "feat:"/"feat(scope):" → minor, anything else → patch.
# Prints nothing when there are no commits since the last tag. First release is 1.0.0.
set -euo pipefail
last="$(git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' 2>/dev/null || true)"
if [ -z "$last" ]; then echo "1.0.0"; exit 0; fi
[ -z "$(git rev-list "$last..HEAD")" ] && exit 0

IFS=. read -r major minor patch <<<"${last#v}"
log="$(git log --format='%s%n%b' "$last..HEAD")"
if grep -qE '^[a-z]+(\([^)]*\))?!:|^BREAKING CHANGE' <<<"$log"; then
  echo "$((major + 1)).0.0"
elif grep -qE '^feat(\([^)]*\))?:' <<<"$log"; then
  echo "$major.$((minor + 1)).0"
else
  echo "$major.$minor.$((patch + 1))"
fi
