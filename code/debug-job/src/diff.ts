// Unified diff for the Debug Job wrapper: compares the untouched copy of each
// uploaded repository with the copy Claude may have edited and returns one
// patch. Pure and deterministic; uses no git, diff or shell subprocess.

import { isUtf8 } from 'node:buffer';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONTEXT = 3;
/**
 * Above this many changed lines in one file the exact Myers search is given up
 * and the changed middle of the file is shown as removed then added. The patch
 * stays correct, only less compact, and time and memory stay bounded.
 */
const MAX_EDIT_DISTANCE = 2000;
const NO_NEWLINE = '\\ No newline at end of file\n';
// Names with control characters (newline, tab, ...) could break the patch format.
const UNSAFE_NAME = /[\u0000-\u001f\u007f]/;

type Op = 'eq' | 'del' | 'ins';

interface Edit {
  op: Op;
  line: string;
}

/** Splits text into lines that keep their "\n"; the last one may lack it. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length - 1; i += 1) out.push(`${lines[i]}\n`);
  const last = lines[lines.length - 1] ?? '';
  if (last !== '') out.push(last);
  return out;
}

/** Myers shortest edit script between two id arrays, or null past the distance limit. */
function myers(a: Int32Array, b: Int32Array): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  // d never goes past the cap, so neither does |k|: size v from the cap, not the file.
  const bound = Math.min(max, MAX_EDIT_DISTANCE);
  const offset = bound + 1;
  const v = new Int32Array(2 * bound + 3);
  const trace: Int32Array[] = [];
  v[offset + 1] = 0;
  for (let d = 0; d <= max; d += 1) {
    if (d > MAX_EDIT_DISTANCE) return null;
    // v for k in [-d-1, d+1] as it was before step d.
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], n: number, m: number): Op[] {
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const saved = trace[d]!;
    const at = (k: number): number => saved[k + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push('eq');
      x -= 1;
      y -= 1;
    }
    if (d > 0) ops.push(x === prevX ? 'ins' : 'del');
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

/** Line-level edit script from a to b. */
export function diffLines(a: string[], b: string[]): Edit[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const ids = new Map<string, number>();
  const toIds = (lines: string[], from: number, to: number): Int32Array => {
    const out = new Int32Array(to - from);
    for (let i = from; i < to; i += 1) {
      const line = lines[i]!;
      let id = ids.get(line);
      if (id === undefined) {
        id = ids.size;
        ids.set(line, id);
      }
      out[i - from] = id;
    }
    return out;
  };
  const middleA = toIds(a, start, endA);
  const middleB = toIds(b, start, endB);
  let ops = myers(middleA, middleB);
  if (ops === null) {
    ops = [...new Array<Op>(middleA.length).fill('del'), ...new Array<Op>(middleB.length).fill('ins')];
  }

  const edits: Edit[] = [];
  for (let i = 0; i < start; i += 1) edits.push({ op: 'eq', line: a[i]! });
  let ia = start;
  let ib = start;
  for (const op of ops) {
    if (op === 'eq') {
      edits.push({ op, line: a[ia]! });
      ia += 1;
      ib += 1;
    } else if (op === 'del') {
      edits.push({ op, line: a[ia]! });
      ia += 1;
    } else {
      edits.push({ op, line: b[ib]! });
      ib += 1;
    }
  }
  for (let i = endA; i < a.length; i += 1) edits.push({ op: 'eq', line: a[i]! });
  return edits;
}

function range(start: number, count: number): string {
  if (count === 0) return `${start},0`;
  if (count === 1) return `${start + 1}`;
  return `${start + 1},${count}`;
}

function printLine(prefix: string, line: string): string {
  return line.endsWith('\n') ? `${prefix}${line}` : `${prefix}${line}\n${NO_NEWLINE}`;
}

/** Unified diff hunks (3 context lines) for two texts, without file headers. */
export function unifiedHunks(oldText: string, newText: string): string {
  const edits = diffLines(splitLines(oldText), splitLines(newText));
  const changes: number[] = [];
  edits.forEach((edit, i) => {
    if (edit.op !== 'eq') changes.push(i);
  });
  if (changes.length === 0) return '';

  // Old and new line positions before each edit.
  const posA: number[] = [];
  const posB: number[] = [];
  let a = 0;
  let b = 0;
  for (const edit of edits) {
    posA.push(a);
    posB.push(b);
    if (edit.op !== 'ins') a += 1;
    if (edit.op !== 'del') b += 1;
  }

  const groups: Array<[number, number]> = [];
  for (const i of changes) {
    const from = Math.max(0, i - CONTEXT);
    const to = Math.min(edits.length, i + 1 + CONTEXT);
    const last = groups[groups.length - 1];
    if (last !== undefined && from <= last[1]) last[1] = to;
    else groups.push([from, to]);
  }

  let out = '';
  for (const [from, to] of groups) {
    let oldCount = 0;
    let newCount = 0;
    let body = '';
    for (let i = from; i < to; i += 1) {
      const edit = edits[i]!;
      if (edit.op === 'eq') {
        oldCount += 1;
        newCount += 1;
        body += printLine(' ', edit.line);
      } else if (edit.op === 'del') {
        oldCount += 1;
        body += printLine('-', edit.line);
      } else {
        newCount += 1;
        body += printLine('+', edit.line);
      }
    }
    out += `@@ -${range(posA[from]!, oldCount)} +${range(posB[from]!, newCount)} @@\n${body}`;
  }
  return out;
}

/** Sorted relative paths ("/" separated) of the regular files under root; [] if root is missing. */
export function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    let entries;
    try {
      entries = readdirSync(rel === '' ? root : join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out.push(path);
    }
  };
  try {
    if (!lstatSync(root).isDirectory()) return [];
  } catch {
    return [];
  }
  walk('');
  return out.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
}

function readRegular(path: string): Buffer | null {
  try {
    if (!lstatSync(path).isFile()) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
}

/**
 * One unified diff of pristineRoot/{folder} against workRoot/{folder} for each
 * folder in order, files in sorted path order, with a/{folder}/{path} and
 * b/{folder}/{path} headers (/dev/null for added or deleted files). Files with
 * a NUL byte or invalid UTF-8 on either side and names with control
 * characters are skipped.
 * When limit is given, stops adding files once the patch is longer than limit.
 */
export function diffTrees(pristineRoot: string, workRoot: string, folders: readonly string[], limit?: number): string {
  let patch = '';
  for (const folder of folders) {
    const before = join(pristineRoot, folder);
    const after = join(workRoot, folder);
    const paths = [...new Set([...listFiles(before), ...listFiles(after)])].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    for (const path of paths) {
      if (limit !== undefined && patch.length > limit) return patch;
      if (UNSAFE_NAME.test(path) || UNSAFE_NAME.test(folder)) continue;
      const oldData = readRegular(join(before, path));
      const newData = readRegular(join(after, path));
      if (oldData === null && newData === null) continue;
      if (oldData !== null && newData !== null && oldData.equals(newData)) continue;
      if (oldData?.includes(0) || newData?.includes(0)) continue;
      // Non-UTF-8 text would be decoded lossily and give a patch that does not apply.
      if ((oldData !== null && !isUtf8(oldData)) || (newData !== null && !isUtf8(newData))) continue;
      const hunks = unifiedHunks(oldData?.toString('utf8') ?? '', newData?.toString('utf8') ?? '');
      if (hunks === '') continue;
      const oldName = oldData === null ? '/dev/null' : `a/${folder}/${path}`;
      const newName = newData === null ? '/dev/null' : `b/${folder}/${path}`;
      patch += `--- ${oldName}\n+++ ${newName}\n${hunks}`;
    }
  }
  return patch;
}
