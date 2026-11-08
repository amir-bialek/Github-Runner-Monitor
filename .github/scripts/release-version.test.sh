#!/usr/bin/env bash
# Tests for release-version.sh (Story 8.1) in throwaway git repositories.
#
#   bash .github/scripts/release-version.test.sh
set -uo pipefail

script="$(cd "$(dirname "$0")" && pwd)/release-version.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

passed=0
failed=0
pass() { passed=$((passed + 1)); echo "ok   - $1"; }
fail() { failed=$((failed + 1)); echo "FAIL - $1"; [ $# -gt 1 ] && printf '%s\n' "$2" | sed 's/^/       /'; }

# new_repo <name> <chart version> [tags...]: a repository with one commit.
new_repo() {
  local dir="$work/$1" chart_version="$2"
  shift 2
  mkdir -p "$dir/helm/chart"
  printf 'apiVersion: v2\nappVersion: %s\nname: app\nversion: %s\n' "$chart_version" "$chart_version" >"$dir/helm/chart/Chart.yaml"
  git -C "$dir" init -q
  git -C "$dir" -c user.email=t@example.com -c user.name=test add .
  git -C "$dir" -c user.email=t@example.com -c user.name=test commit -q -m init
  local tag
  for tag in "$@"; do git -C "$dir" tag "$tag"; done
  echo "$dir"
}

expect_version() { # name, repo, bump, ref, expected
  local out
  if out="$(cd "$2" && bash "$script" "$3" "$4" 2>&1)" && [ "$out" = "$5" ]; then
    pass "$1"
  else
    fail "$1 (expected $5)" "$out"
  fi
}

expect_refused() { # name, repo, bump, ref, message fragment
  local out
  if out="$(cd "$2" && bash "$script" "$3" "$4" 2>&1)"; then
    fail "$1 (succeeded, should have failed)" "$out"
  elif [ "$(wc -l <<<"$out")" -eq 1 ] && grep -qF -- "$5" <<<"$out"; then
    pass "$1"
  else
    fail "$1 (message does not name '$5' on one line)" "$out"
  fi
}

main=refs/heads/main

first="$(new_repo first 1.0.0 backend-v1.0.5 frontend-v1.0.2)"
expect_version "first release, major from Chart.yaml 1.0.0" "$first" major "$main" 2.0.0
expect_version "first release, minor from Chart.yaml 1.0.0" "$first" minor "$main" 1.1.0
expect_version "first release, patch from Chart.yaml 1.0.0" "$first" patch "$main" 1.0.1

later="$(new_repo later 1.0.0 v2.0.0 v2.1.0 v2.0.9 v10.0.0-rc1)"
expect_version "later patch from highest tag" "$later" patch "$main" 2.1.1
expect_version "later minor from highest tag" "$later" minor "$main" 2.2.0
expect_version "later major from highest tag" "$later" major "$main" 3.0.0

sorted="$(new_repo sorted 1.0.0 v2.9.0 v2.10.0)"
expect_version "versions sort numerically" "$sorted" patch "$main" 2.10.1

quoted="$(new_repo quoted 1.0.0)"
sed -i 's/^version: .*/version: "1.0.0"/' "$quoted/helm/chart/Chart.yaml"
expect_version "quoted Chart.yaml version" "$quoted" major "$main" 2.0.0

zero="$(new_repo zero 1.0.0 v1.08.0)"
expect_version "leading zero read as decimal, patch" "$zero" patch "$main" 1.8.1
expect_version "leading zero read as decimal, minor" "$zero" minor "$main" 1.9.0

short="$(new_repo short 1.0)"
expect_refused "Chart.yaml version not X.Y.Z" "$short" major "$main" "is not X.Y.Z"

nochart="$(new_repo nochart 1.0.0)"
git -C "$nochart" rm -q -r helm
expect_refused "no tag and no Chart.yaml" "$nochart" major "$main" "no helm/chart/Chart.yaml"

expect_refused "invalid bump" "$first" huge "$main" "use major, minor or patch"
expect_refused "empty bump" "$first" "" "$main" "use major, minor or patch"
expect_refused "not main" "$first" patch refs/heads/feature "Release runs only from main"
expect_refused "tag ref" "$first" patch refs/tags/v2.0.0 "Release runs only from main"

echo "# $passed passed, $failed failed"
[ "$failed" -eq 0 ]
