#!/usr/bin/env bash
# Computes the next release version for Release Publish (Story 8.1, AD-15).
#
#   bash .github/scripts/release-version.sh <major|minor|patch> <git ref>
#
# Run from the repository root with the full tag history. The base is the
# highest vX.Y.Z git tag or, when there is none, helm/chart/Chart.yaml version.
# Prints X.Y.Z on stdout. Every refusal exits 1 with one line on stderr.
set -euo pipefail

refuse() { echo "$1" >&2; exit 1; }

bump="${1:-}"
ref="${2:-}"

case "$bump" in
  major|minor|patch) ;;
  *) refuse "Invalid bump '$bump': use major, minor or patch." ;;
esac

[ "$ref" = "refs/heads/main" ] || refuse "Release runs only from main, not '$ref'."

latest="$(git tag -l 'v[0-9]*.[0-9]*.[0-9]*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n1 || true)"
base="${latest#v}"
if [ -z "$base" ]; then
  [ -f helm/chart/Chart.yaml ] || refuse "No vX.Y.Z tag and no helm/chart/Chart.yaml to read the version from."
  base="$(sed -n 's/^version: *//p' helm/chart/Chart.yaml | head -n1 | tr -d "\"' \r")"
fi
[[ "$base" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || refuse "Base version '$base' is not X.Y.Z."

IFS=. read -r X Y Z <<<"$base"
case "$bump" in
  major) version="$((10#$X + 1)).0.0" ;;
  minor) version="$((10#$X)).$((10#$Y + 1)).0" ;;
  patch) version="$((10#$X)).$((10#$Y)).$((10#$Z + 1))" ;;
esac

if git rev-parse -q --verify "refs/tags/v$version" >/dev/null; then
  refuse "Tag v$version already exists."
fi

echo "$version"
