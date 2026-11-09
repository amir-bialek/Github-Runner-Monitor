#!/usr/bin/env bash
# Checks and prints the release version (Story 8.1, AD-15).
#
#   bash .github/scripts/release-version.sh [base ref]
#
# Run from the repository root with the full history. The version is set by
# hand in the pull request: helm/chart/Chart.yaml version and appVersion, and
# the image tags in helm/values-backend.yaml (backend-vX.Y.Z) and
# helm/values-frontend.yaml (frontend-vX.Y.Z). All must match, tag vX.Y.Z must
# not exist, and CHANGELOG.md and docs/images/vMAJOR must have the version.
# With a base ref (PR Validate), the version must also be higher than the
# Chart.yaml version on that ref. Prints X.Y.Z on stdout. Every refusal exits 1
# with one line on stderr.
set -euo pipefail

refuse() { echo "$1" >&2; exit 1; }

# read_value <key>: the first "<key>: value" line on stdin, unquoted.
read_value() {
  sed -n "s/^ *$1: *//p" | head -n1 | sed 's/ #.*//' | tr -d "\"' \r"
}

for file in helm/chart/Chart.yaml helm/values-backend.yaml helm/values-frontend.yaml; do
  [ -f "$file" ] || refuse "No $file to read the version from."
done

version="$(read_value version <helm/chart/Chart.yaml)"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || refuse "Chart.yaml version '$version' is not X.Y.Z."

app_version="$(read_value appVersion <helm/chart/Chart.yaml)"
[ "$app_version" = "$version" ] || refuse "Chart.yaml appVersion '$app_version' is not version '$version'."

backend_tag="$(read_value tag <helm/values-backend.yaml)"
[ "$backend_tag" = "backend-v$version" ] || refuse "helm/values-backend.yaml image tag '$backend_tag' is not 'backend-v$version'."

frontend_tag="$(read_value tag <helm/values-frontend.yaml)"
[ "$frontend_tag" = "frontend-v$version" ] || refuse "helm/values-frontend.yaml image tag '$frontend_tag' is not 'frontend-v$version'."

if git rev-parse -q --verify "refs/tags/v$version" >/dev/null; then
  refuse "Tag v$version already exists: raise the version in Chart.yaml and both values files."
fi

if [ -n "${1:-}" ]; then
  base="$(git show "$1:helm/chart/Chart.yaml" | read_value version)"
  if [ "$(printf '%s\n%s\n' "$version" "$base" | sort -V | tail -n1)" = "$base" ]; then
    refuse "Version $version is not higher than $base on main: raise it in Chart.yaml and both values files."
  fi
fi

notes="$(dirname "$0")/release-notes.sh"
bash "$notes" "$version" >/dev/null
bash "$notes" "$version" --images >/dev/null

echo "$version"
