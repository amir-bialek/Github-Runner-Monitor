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

# set_version <dir> <version>: Chart.yaml, both values files and a CHANGELOG.md
# section all carry <version>.
set_version() {
  local dir="$1" version="$2"
  mkdir -p "$dir/helm/chart" "$dir/docs/images/v${version%%.*}"
  printf 'apiVersion: v2\nappVersion: %s\nname: app\nversion: %s\n' "$version" "$version" >"$dir/helm/chart/Chart.yaml"
  printf 'deployment:\n  image:\n    name: x\n    tag: backend-v%s\ndebugIt:\n  jobImage:\n    tag: ""\n' "$version" >"$dir/helm/values-backend.yaml"
  printf 'deployment:\n  image:\n    name: x\n    tag: frontend-v%s\n' "$version" >"$dir/helm/values-frontend.yaml"
  printf '# Changelog\n\n## %s\n\nNotes.\n' "$version" >"$dir/CHANGELOG.md"
  touch "$dir/docs/images/v${version%%.*}/screen.png"
}

# new_repo <name> <version> [tags...]: a repository with one commit.
new_repo() {
  local dir="$work/$1"
  set_version "$dir" "$2"
  shift 2
  git -C "$dir" init -q
  git -C "$dir" -c user.email=t@example.com -c user.name=test add .
  git -C "$dir" -c user.email=t@example.com -c user.name=test commit -q -m init
  local tag
  for tag in "$@"; do git -C "$dir" tag "$tag"; done
  echo "$dir"
}

expect_version() { # name, repo, expected, [base ref]
  local out
  if out="$(cd "$2" && bash "$script" ${4:+"$4"} 2>&1)" && [ "$out" = "$3" ]; then
    pass "$1"
  else
    fail "$1 (expected $3)" "$out"
  fi
}

expect_refused() { # name, repo, message fragment, [base ref]
  local out
  if out="$(cd "$2" && bash "$script" ${4:+"$4"} 2>&1)"; then
    fail "$1 (succeeded, should have failed)" "$out"
  elif [ "$(wc -l <<<"$out")" -eq 1 ] && grep -qF -- "$3" <<<"$out"; then
    pass "$1"
  else
    fail "$1 (message does not name '$3' on one line)" "$out"
  fi
}

first="$(new_repo first 2.1.0 backend-v1.0.5 frontend-v1.0.2)"
expect_version "first release, no vX.Y.Z tag" "$first" 2.1.0

quoted="$(new_repo quoted 2.1.0)"
sed -i 's/^version: .*/version: "2.1.0"/' "$quoted/helm/chart/Chart.yaml"
sed -i 's/tag: frontend-v2.1.0/tag: frontend-v2.1.0 # pinned/' "$quoted/helm/values-frontend.yaml"
expect_version "quoted version and comment after tag" "$quoted" 2.1.0

exists="$(new_repo exists 2.1.0 v2.1.0)"
expect_refused "tag already exists" "$exists" "Tag v2.1.0 already exists"

# A pull request on top of main at 2.1.0.
pr="$(new_repo pr 2.1.0)"
set_version "$pr" 2.10.0
expect_version "higher than main, compared numerically" "$pr" 2.10.0 HEAD
set_version "$pr" 2.1.0
expect_refused "same as main" "$pr" "not higher than 2.1.0 on main" HEAD
set_version "$pr" 2.0.5
expect_refused "lower than main" "$pr" "not higher than 2.1.0 on main" HEAD

# Main at 2.2.0 whose release never finished, after v2.1.0.
unreleased="$(new_repo unreleased 2.2.0 v2.1.0)"
set_version "$unreleased" 2.3.0
expect_refused "main's version never released" "$unreleased" "2.2.0 on main was never released" HEAD
git -C "$unreleased" tag v2.2.0
expect_version "main's version released" "$unreleased" 2.3.0 HEAD

app="$(new_repo app 2.1.0)"
sed -i 's/^appVersion: .*/appVersion: 2.0.0/' "$app/helm/chart/Chart.yaml"
expect_refused "appVersion differs" "$app" "appVersion '2.0.0' is not version '2.1.0'"

backend="$(new_repo backend 2.1.0)"
sed -i 's/backend-v2.1.0/backend-v2.0.0/' "$backend/helm/values-backend.yaml"
expect_refused "backend tag differs" "$backend" "is not 'backend-v2.1.0'"

frontend="$(new_repo frontend 2.1.0)"
sed -i 's/frontend-v2.1.0/latest/' "$frontend/helm/values-frontend.yaml"
expect_refused "frontend tag differs" "$frontend" "is not 'frontend-v2.1.0'"

notes="$(new_repo notes 2.1.0)"
printf '# Changelog\n\n## 2.0.0\n\nNotes.\n' >"$notes/CHANGELOG.md"
expect_refused "no CHANGELOG.md section" "$notes" "2.1.0"

images="$(new_repo images 3.0.0)"
rm -r "$images/docs/images/v3"
expect_refused "no screenshot for the major version" "$images" "docs/images/v3"

short="$(new_repo short 1.0)"
expect_refused "Chart.yaml version not X.Y.Z" "$short" "is not X.Y.Z"

nochart="$(new_repo nochart 2.1.0)"
rm "$nochart/helm/chart/Chart.yaml"
expect_refused "no Chart.yaml" "$nochart" "No helm/chart/Chart.yaml"

echo "# $passed passed, $failed failed"
[ "$failed" -eq 0 ]
