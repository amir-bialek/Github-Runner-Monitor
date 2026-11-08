#!/usr/bin/env bash
# Tests for release-notes.sh (Story 8.5) in throwaway folders, then a check
# on the real repository.
#
#   bash .github/scripts/release-notes.test.sh
set -uo pipefail

script="$(cd "$(dirname "$0")" && pwd)/release-notes.sh"
root="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

passed=0
failed=0
pass() { passed=$((passed + 1)); echo "ok   - $1"; }
fail() { failed=$((failed + 1)); echo "FAIL - $1"; [ $# -gt 1 ] && printf '%s\n' "$2" | sed 's/^/       /'; }

# new_dir <name> <changelog text|-> [png paths...]: a folder with that
# CHANGELOG.md ('-' for none) and empty PNG files.
new_dir() {
  local dir="$work/$1" changelog="$2"
  shift 2
  mkdir -p "$dir"
  [ "$changelog" = "-" ] || printf '%s' "$changelog" >"$dir/CHANGELOG.md"
  local png
  for png in "$@"; do mkdir -p "$dir/$(dirname "$png")"; : >"$dir/$png"; done
  echo "$dir"
}

expect_output() { # name, dir, expected, args...
  local name="$1" dir="$2" expected="$3" out
  shift 3
  if out="$(cd "$dir" && bash "$script" "$@" 2>&1)" && [ "$out" = "$expected" ]; then
    pass "$name"
  else
    fail "$name" "$(printf 'expected:\n%s\ngot:\n%s' "$expected" "$out")"
  fi
}

expect_refused() { # name, dir, message fragment, args...
  local name="$1" dir="$2" fragment="$3" out
  shift 3
  if out="$(cd "$dir" && bash "$script" "$@" 2>/dev/null)"; then
    fail "$name (succeeded, should have failed)" "$out"
    return
  fi
  if [ -n "$out" ]; then
    fail "$name (printed to stdout while refusing)" "$out"
    return
  fi
  out="$(cd "$dir" && bash "$script" "$@" 2>&1 >/dev/null)"
  if [ "$(wc -l <<<"$out")" -eq 1 ] && grep -qF -- "$fragment" <<<"$out"; then
    pass "$name"
  else
    fail "$name (message does not name '$fragment' on one line)" "$out"
  fi
}

changelog='# Changelog

Intro text.

## 2.0.10

### What changed

- Ten.

## 2.0.1

### What changed

- One.

### Upgrade steps

1. Nothing.

## 2.0.0

### What changed

- First 2.0.

## 3.0.0

## 1.x

- Old summary.

## 4.0.0


Last section text.

'

images=(docs/images/v2/b.png docs/images/v2/a.png docs/images/v2/notes.txt docs/images/v4/x.png docs/images/v1/old.png)
full="$(new_dir full "$changelog" "${images[@]}")"

expect_output "notes found" "$full" "$(printf '### What changed\n\n- First 2.0.')" 2.0.0
expect_output "section with subsections, trimmed" "$full" \
  "$(printf '### What changed\n\n- One.\n\n### Upgrade steps\n\n1. Nothing.')" 2.0.1
expect_output "similar heading not matched (2.0.1 vs 2.0.10)" "$full" "$(printf '### What changed\n\n- Ten.')" 2.0.10
expect_output "last section runs to end of file" "$full" "Last section text." 4.0.0
expect_output "--images prints sorted PNG paths only" "$full" \
  "$(printf 'docs/images/v2/a.png\ndocs/images/v2/b.png')" 2.0.0 --images
expect_output "patch release reuses its major's screenshots" "$full" \
  "$(printf 'docs/images/v2/a.png\ndocs/images/v2/b.png')" 2.0.10 --images

expect_refused "missing section" "$full" "No CHANGELOG.md section '## 2.1.0'." 2.1.0
expect_refused "missing section, --images" "$full" "No CHANGELOG.md section '## 2.1.0'." 2.1.0 --images
expect_refused "empty section" "$full" "'## 3.0.0' is empty" 3.0.0
expect_refused "invalid version with v prefix" "$full" "Invalid version" v2.0.0
expect_refused "invalid version, empty" "$full" "Invalid version" ""
expect_refused "invalid version, missing" "$full" "Invalid version"
expect_refused "invalid version, two parts" "$full" "Invalid version" 2.0
expect_refused "invalid version, 1.x" "$full" "Invalid version" 1.x
expect_refused "invalid option" "$full" "Invalid option" 2.0.0 --all
expect_refused "too many arguments" "$full" "Too many arguments" 2.0.0 --images extra

noimages="$(new_dir noimages "$(printf '# Changelog\n\n## 3.0.0\n\n- Three.\n')" docs/images/v2/a.png)"
expect_refused "no screenshots for the major" "$noimages" "docs/images/v3" 3.0.0
expect_refused "no screenshots for the major, --images" "$noimages" "docs/images/v3" 3.0.0 --images
mkdir -p "$noimages/docs/images/v3" && : >"$noimages/docs/images/v3/readme.txt"
expect_refused "screenshot folder without a PNG" "$noimages" "docs/images/v3" 3.0.0

nochangelog="$(new_dir nochangelog - docs/images/v2/a.png)"
expect_refused "no CHANGELOG.md" "$nochangelog" "No CHANGELOG.md" 2.0.0

lastempty="$(new_dir lastempty "$(printf '# Changelog\n\n## 2.0.0\n   \n')" docs/images/v2/a.png)"
expect_refused "empty last section" "$lastempty" "'## 2.0.0' is empty" 2.0.0

crlf="$(new_dir crlf "$(printf '# Changelog\r\n\r\n## 2.0.0\r\n\r\n- Windows line.\r\n')" docs/images/v2/a.png)"
expect_output "CRLF line endings" "$crlf" "- Windows line." 2.0.0

# The real repository.
if out="$(cd "$root" && bash "$script" 2.0.0 2>&1)"; then
  pass "real CHANGELOG.md has 2.0.0 notes"
  for word in "Workflow runs" "administrator" "### What changed" "### Upgrade steps"; do
    if grep -qF -- "$word" <<<"$out"; then pass "real 2.0.0 notes mention '$word'"; else fail "real 2.0.0 notes mention '$word'"; fi
  done
  steps="$(sed -n '/^### Upgrade steps/,/^### /p' <<<"$out")"
  for word in "Workflow runs" "administrator"; do
    if grep -qF -- "$word" <<<"$steps"; then pass "real 2.0.0 upgrade steps mention '$word'"; else fail "real 2.0.0 upgrade steps mention '$word'"; fi
  done
else
  fail "real CHANGELOG.md has 2.0.0 notes" "$out"
fi

for png in alert-settings alerts-popover dashboard-light header-controls; do
  if [ -f "$root/docs/images/v1/$png.png" ]; then pass "real docs/images/v1 holds $png.png"; else fail "real docs/images/v1 holds $png.png"; fi
done
if grep -qF '](docs/images/v1)' "$root/README.md"; then pass "README.md links docs/images/v1"; else fail "README.md links docs/images/v1"; fi

if out="$(cd "$root" && bash "$script" 2.0.0 --images 2>&1)" && grep -qx 'docs/images/v2/security-page.png' <<<"$out"; then
  pass "real docs/images/v2 holds security-page.png"
else
  fail "real docs/images/v2 holds security-page.png" "$out"
fi

if grep -qx '## 1.x' "$root/CHANGELOG.md"; then pass "real CHANGELOG.md has '## 1.x'"; else fail "real CHANGELOG.md has '## 1.x'"; fi

# Every link or image target under docs/images (prose such as docs/images/vN is not a link).
readme_images="$(grep -oE '\]\(docs/images/[^)#[:space:]]+' "$root/README.md" | sed 's/^](//' | sort -u)"
missing=""
for path in $readme_images; do
  [ -e "$root/$path" ] || missing="$missing $path"
done
if [ -n "$readme_images" ] && [ -z "$missing" ]; then
  pass "every docs/images path in README.md exists"
else
  fail "every docs/images path in README.md exists" "missing:${missing:- (no paths found)}"
fi

stale="$(grep -oE '!\[[^]]*\]\([^)]*\)' "$root/README.md" | grep -vE '\(docs/images/v2/[^)]+\.png\)' || true)"
if [ -z "$stale" ]; then pass "every README.md image is in docs/images/v2"; else fail "every README.md image is in docs/images/v2" "$stale"; fi

echo
echo "$passed passed, $failed failed"
[ "$failed" -eq 0 ]
