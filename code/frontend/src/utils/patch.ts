// Helpers for showing a unified diff as plain text (story 3.12). Nothing here
// builds HTML: the patch is split into lines that render as text nodes.

export type PatchLineKind = 'added' | 'removed' | 'context';

/** The lines of a patch, without the empty line after a final newline. */
export function patchLines(patch: string): string[] {
  const lines = patch.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Whether lines[i] and lines[i + 1] are a `--- `/`+++ ` file header pair: only
// when a hunk (`@@`) follows, so a removed `-- x` or added `++ y` line inside a
// hunk is never taken for a header.
function isHeaderPair(lines: string[], i: number): boolean {
  return (
    (lines[i] ?? '').startsWith('--- ') &&
    (lines[i + 1] ?? '').startsWith('+++ ') &&
    (lines[i + 2] ?? '').startsWith('@@')
  );
}

/** What each line of a patch is; file header lines are context. */
export function patchLineKinds(lines: string[]): PatchLineKind[] {
  const kinds: PatchLineKind[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (isHeaderPair(lines, i)) {
      kinds.push('context', 'context');
      i += 1;
      continue;
    }
    const line = lines[i]!;
    kinds.push(line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : 'context');
  }
  return kinds;
}

// The path of a `--- a/x` or `+++ b/x` header, without the a/ or b/ prefix and any tab-separated timestamp.
function headerPath(line: string): string {
  const raw = line.slice(4).split('\t')[0]!.trim();
  return raw.replace(/^[ab]\//, '');
}

/**
 * The unique file paths a patch changes, in order: the new side of each file
 * header, or the old side when the new side is /dev/null (a deleted file).
 */
export function patchFiles(patch: string): string[] {
  const files: string[] = [];
  const lines = patchLines(patch);
  for (let i = 0; i < lines.length; i += 1) {
    if (!isHeaderPair(lines, i)) continue;
    let path = headerPath(lines[i + 1]!);
    if (path === '/dev/null') path = headerPath(lines[i]!);
    i += 1;
    if (path !== '' && path !== '/dev/null' && !files.includes(path)) files.push(path);
  }
  return files;
}
