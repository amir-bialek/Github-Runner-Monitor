import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { diffLines, diffTrees, listFiles, splitLines, unifiedHunks } from '../src/diff.ts';

/** Minimal applier for the hunks unifiedHunks writes, to check round trips. */
function apply(oldText: string, hunks: string): string {
  const oldLines = splitLines(oldText);
  const out: string[] = [];
  let at = 0;
  const lines = hunks.split('\n');
  let i = 0;
  while (i < lines.length && lines[i] !== '') {
    const header = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@$/.exec(lines[i]!);
    if (!header) throw new Error('bad hunk header');
    const start = Number(header[1]);
    const count = header[2] === undefined ? 1 : Number(header[2]);
    const from = count === 0 ? start : start - 1;
    while (at < from) out.push(oldLines[at++]!);
    i += 1;
    while (i < lines.length && lines[i] !== '' && !lines[i]!.startsWith('@@')) {
      const line = lines[i]!;
      const noNewline = lines[i + 1] === '\\ No newline at end of file';
      const text = line.slice(1) + (noNewline ? '' : '\n');
      if (line[0] === ' ') {
        expect(oldLines[at]).toBe(text);
        out.push(text);
        at += 1;
      } else if (line[0] === '-') {
        expect(oldLines[at]).toBe(text);
        at += 1;
      } else if (line[0] === '+') {
        out.push(text);
      } else {
        throw new Error('bad hunk line');
      }
      i += noNewline ? 2 : 1;
    }
  }
  while (at < oldLines.length) out.push(oldLines[at++]!);
  return out.join('');
}

/** Small deterministic PRNG so the random cases are the same on every run. */
function prng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

describe('splitLines', () => {
  it('keeps line ends and marks a missing final newline', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a\nb\n')).toEqual(['a\n', 'b\n']);
    expect(splitLines('a\nb')).toEqual(['a\n', 'b']);
    expect(splitLines('\n')).toEqual(['\n']);
  });
});

describe('unifiedHunks', () => {
  it('returns nothing for equal texts', () => {
    expect(unifiedHunks('a\nb\n', 'a\nb\n')).toBe('');
  });

  it('writes one hunk with 3 context lines', () => {
    const before = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((l) => `${l}\n`).join('');
    const after = before.replace('5\n', 'five\n');
    expect(unifiedHunks(before, after)).toBe(
      ['@@ -2,7 +2,7 @@', ' 2', ' 3', ' 4', '-5', '+five', ' 6', ' 7', ' 8', ''].join('\n'),
    );
  });

  it('splits far apart changes into two hunks and joins close ones', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}\n`);
    const far = [...lines];
    far[1] = 'changed 2\n';
    far[17] = 'changed 18\n';
    const hunks = unifiedHunks(lines.join(''), far.join(''));
    expect(hunks.match(/^@@/gm)).toHaveLength(2);
    expect(hunks).toContain('@@ -1,5 +1,5 @@');
    expect(hunks).toContain('@@ -15,6 +15,6 @@');
    const close = [...lines];
    close[4] = 'changed 5\n';
    close[11] = 'changed 12\n';
    expect(unifiedHunks(lines.join(''), close.join('')).match(/^@@/gm)).toHaveLength(1);
  });

  it('marks a missing newline at the end on either side', () => {
    expect(unifiedHunks('a\nb', 'a\nb\n')).toBe(['@@ -1,2 +1,2 @@', ' a', '-b', '\\ No newline at end of file', '+b', ''].join('\n'));
    expect(unifiedHunks('a\n', 'a\nb')).toBe(['@@ -1 +1,2 @@', ' a', '+b', '\\ No newline at end of file', ''].join('\n'));
  });

  it('writes added and removed whole files', () => {
    expect(unifiedHunks('', 'x\ny\n')).toBe('@@ -0,0 +1,2 @@\n+x\n+y\n');
    expect(unifiedHunks('x\n', '')).toBe('@@ -1 +0,0 @@\n-x\n');
  });

  it('round-trips random edits', () => {
    const random = prng(42);
    const words = ['alpha', 'beta', 'gamma', 'delta', '', 'acme'];
    const pick = (): string => words[Math.floor(random() * words.length)]!;
    for (let round = 0; round < 300; round += 1) {
      const before = Array.from({ length: Math.floor(random() * 30) }, pick);
      const after = [...before];
      const edits = Math.floor(random() * 6);
      for (let e = 0; e < edits; e += 1) {
        const at = Math.floor(random() * (after.length + 1));
        const kind = random();
        if (kind < 0.33) after.splice(at, 1);
        else if (kind < 0.66) after.splice(at, 0, pick());
        else after[at] = pick();
      }
      const join = (lines: string[], end: boolean): string => (lines.length ? lines.join('\n') + (end ? '\n' : '') : '');
      const oldText = join(before, random() < 0.8);
      const newText = join(after.filter((l) => l !== undefined), random() < 0.8);
      expect(apply(oldText, unifiedHunks(oldText, newText))).toBe(newText);
    }
  });

  it('stays correct when the edit distance is over the search limit', () => {
    const before = Array.from({ length: 3000 }, (_, i) => `old ${i}\n`).join('');
    const after = `keep\n${Array.from({ length: 3000 }, (_, i) => `new ${i}\n`).join('')}`;
    const hunks = unifiedHunks(`keep\n${before}`, after);
    expect(apply(`keep\n${before}`, hunks)).toBe(after);
  });

  it('finds a minimal edit script', () => {
    const ops = diffLines(['a\n', 'b\n', 'c\n'], ['a\n', 'c\n', 'd\n']).map((e) => e.op);
    expect(ops.filter((op) => op !== 'eq')).toHaveLength(2);
  });
});

describe('diffTrees', () => {
  let root: string;
  const put = (path: string, data: string | Buffer): void => {
    mkdirSync(resolve(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), data);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'diff-test-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('diffs each folder in order with files in sorted path order', () => {
    put('pristine/payments-api/b.ts', 'b\n');
    put('pristine/payments-api/a/z.ts', 'z\n');
    put('pristine/payments-api/same.ts', 'same\n');
    put('pristine/shared-actions/action.yml', 'name: old\n');
    put('work/payments-api/b.ts', 'B\n');
    put('work/payments-api/a/z.ts', 'Z\n');
    put('work/payments-api/same.ts', 'same\n');
    put('work/shared-actions/action.yml', 'name: new\n');
    expect(diffTrees(join(root, 'pristine'), join(root, 'work'), ['shared-actions', 'payments-api'])).toBe(
      [
        '--- a/shared-actions/action.yml',
        '+++ b/shared-actions/action.yml',
        '@@ -1 +1 @@',
        '-name: old',
        '+name: new',
        '--- a/payments-api/a/z.ts',
        '+++ b/payments-api/a/z.ts',
        '@@ -1 +1 @@',
        '-z',
        '+Z',
        '--- a/payments-api/b.ts',
        '+++ b/payments-api/b.ts',
        '@@ -1 +1 @@',
        '-b',
        '+B',
        '',
      ].join('\n'),
    );
  });

  it('skips files with a NUL byte on either side and ignores links', () => {
    put('pristine/payments-api/logo.png', Buffer.from([0x89, 0x50, 0x00, 0x01]));
    put('work/payments-api/logo.png', Buffer.from([0x89, 0x50, 0x00, 0x02]));
    put('pristine/payments-api/text.txt', 'text\n');
    put('work/payments-api/text.txt', Buffer.from('te\0xt\n'));
    mkdirSync(join(root, 'work/payments-api/sub'), { recursive: true });
    symlinkSync('/etc/hostname', join(root, 'work/payments-api/sub/link'));
    expect(diffTrees(join(root, 'pristine'), join(root, 'work'), ['payments-api'])).toBe('');
    expect(listFiles(join(root, 'work/payments-api'))).toEqual(['logo.png', 'text.txt']);
  });

  it('skips files that are not valid UTF-8 on either side', () => {
    put('pristine/payments-api/latin1.txt', Buffer.from('caf\xe9\n', 'latin1'));
    put('work/payments-api/latin1.txt', Buffer.from('caf\xe8\n', 'latin1'));
    put('pristine/payments-api/ok.txt', 'old\n');
    put('work/payments-api/ok.txt', Buffer.from('new \xff\n', 'latin1'));
    put('pristine/payments-api/utf8.txt', 'caf\u00e9\n');
    put('work/payments-api/utf8.txt', 'caf\u00e8\n');
    expect(diffTrees(join(root, 'pristine'), join(root, 'work'), ['payments-api'])).toBe(
      ['--- a/payments-api/utf8.txt', '+++ b/payments-api/utf8.txt', '@@ -1 +1 @@', '-caf\u00e9', '+caf\u00e8', ''].join('\n'),
    );
  });

  it('skips file names with control characters', () => {
    put('pristine/payments-api/bad\nname.txt', 'old\n');
    put('work/payments-api/bad\nname.txt', 'new\n');
    put('pristine/payments-api/good.txt', 'old\n');
    put('work/payments-api/good.txt', 'new\n');
    const patch = diffTrees(join(root, 'pristine'), join(root, 'work'), ['payments-api']);
    expect(patch).toBe(['--- a/payments-api/good.txt', '+++ b/payments-api/good.txt', '@@ -1 +1 @@', '-old', '+new', ''].join('\n'));
    expect(patch).not.toContain('bad');
  });

  it('stops after the file that passes the limit', () => {
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      put(`pristine/payments-api/${name}`, 'old\n');
      put(`work/payments-api/${name}`, 'new\n');
    }
    put('pristine/shared-actions/action.yml', 'name: old\n');
    put('work/shared-actions/action.yml', 'name: new\n');
    const full = diffTrees(join(root, 'pristine'), join(root, 'work'), ['payments-api', 'shared-actions']);
    const one = '--- a/payments-api/a.txt\n+++ b/payments-api/a.txt\n@@ -1 +1 @@\n-old\n+new\n';
    expect(full.startsWith(one)).toBe(true);
    expect(full).toContain('shared-actions/action.yml');
    expect(diffTrees(join(root, 'pristine'), join(root, 'work'), ['payments-api', 'shared-actions'], one.length - 1)).toBe(one);
    const two = full.slice(0, one.length * 2);
    expect(diffTrees(join(root, 'pristine'), join(root, 'work'), ['payments-api', 'shared-actions'], one.length)).toBe(two);
  });

  it('returns an empty patch for missing folders', () => {
    expect(diffTrees(join(root, 'pristine'), join(root, 'work'), ['payments-api'])).toBe('');
  });
});
