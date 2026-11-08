#!/usr/bin/env bash
# Release notes and screenshots for one version (Story 8.5, FR38, FR39).
#
#   bash .github/scripts/release-notes.sh <X.Y.Z>            # notes
#   bash .github/scripts/release-notes.sh <X.Y.Z> --images   # screenshots
#
# Run from the repository root. Prints the body of the '## X.Y.Z' section of
# CHANGELOG.md (the lines after the heading up to the next '## ' heading,
# trimmed) or, with --images, the PNG paths in docs/images/vMAJOR, one per
# line, sorted. Refuses, before printing anything, when the section is
# missing or empty or the major version has no screenshot. Every refusal
# exits 1 with one line on stderr.
set -euo pipefail

refuse() { echo "$1" >&2; exit 1; }

version="${1:-}"
mode="${2:-}"

[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || refuse "Invalid version '$version': use X.Y.Z."
case "$mode" in
  ''|--images) ;;
  *) refuse "Invalid option '$mode': only --images is accepted." ;;
esac
[ $# -le 2 ] || refuse "Too many arguments: give X.Y.Z and optionally --images."

[ -f CHANGELOG.md ] || refuse "No CHANGELOG.md in $(pwd)."

# Exact heading match: '## 2.0.1' never matches '## 2.0.10'. Trailing
# spaces and a CR on the heading line are tolerated.
grep -qE "^## ${version//./\\.}[[:space:]]*$" CHANGELOG.md \
  || refuse "No CHANGELOG.md section '## $version'."

notes="$(awk -v heading="## $version" '
  { line = $0; sub(/[ \t\r]+$/, "", line) }
  found && /^## / { exit }
  found { print line; next }
  line == heading { found = 1 }
' CHANGELOG.md | sed -e '/[^[:space:]]/,$!d')"
# Leading blank lines are dropped above; every line lost its trailing
# blanks in awk, so $(...) drops the trailing blank lines.
[ -n "$notes" ] || refuse "CHANGELOG.md section '## $version' is empty."

major="${version%%.*}"
major="$((10#$major))"
images_dir="docs/images/v$major"
images="$( { find "$images_dir" -maxdepth 1 -type f -name '*.png' 2>/dev/null || true; } | LC_ALL=C sort)"
[ -n "$images" ] || refuse "No screenshot (.png) in $images_dir for version $version."

if [ "$mode" = "--images" ]; then
  printf '%s\n' "$images"
else
  printf '%s\n' "$notes"
fi
