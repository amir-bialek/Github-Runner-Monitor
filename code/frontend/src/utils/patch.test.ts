import { patchFiles, patchLineKinds, patchLines } from './patch';

describe('patchLineKinds', () => {
  test('added, removed and context lines; file headers are context', () => {
    const lines = ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,2 @@', ' same', '-old', '+new', ''];
    expect(patchLineKinds(lines)).toEqual([
      'context',
      'context',
      'context',
      'context',
      'removed',
      'added',
      'context',
    ]);
  });

  // Lines inside a hunk whose content starts with -- or ++ are not headers.
  const HUNK_EDGE = [
    'diff --git a/config.yml b/config.yml',
    '--- a/config.yml',
    '+++ b/config.yml',
    '@@ -1,3 +1,2 @@',
    '----',
    '--- drop the old comment',
    ' key: value',
    '@@ -10,1 +10,2 @@',
    ' i = 0;',
    '+++i;',
    '+++ x',
  ];

  test('a removed YAML ---, a removed -- comment and added ++ lines keep their kind', () => {
    expect(patchLineKinds(HUNK_EDGE)).toEqual([
      'context',
      'context',
      'context',
      'context',
      'removed',
      'removed',
      'context',
      'context',
      'context',
      'added',
      'added',
    ]);
  });

  test('none of them enter patchFiles', () => {
    expect(patchFiles(HUNK_EDGE.join('\n'))).toEqual(['config.yml']);
  });

  test('patchLines drops only the empty line after a final newline', () => {
    expect(patchLines('a\nb\n')).toEqual(['a', 'b']);
    expect(patchLines('a\r\n\nb')).toEqual(['a', '', 'b']);
  });
});

describe('patchFiles', () => {
  test('unique paths from the new side, without a/ and b/', () => {
    const patch = [
      'diff --git a/src/refund.ts b/src/refund.ts',
      '--- a/src/refund.ts',
      '+++ b/src/refund.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/README.md b/README.md',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '--- a/src/refund.ts',
      '+++ b/src/refund.ts',
      '@@ -5 +5 @@',
      '-x',
      '+y',
    ].join('\n');
    expect(patchFiles(patch)).toEqual(['src/refund.ts', 'README.md']);
  });

  test('a deleted file uses the old side; a new file the new side', () => {
    const patch = [
      '--- a/old/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-x',
      '--- /dev/null',
      '+++ b/new/added.ts\t2026-11-05 10:00:00',
      '@@ -0,0 +1 @@',
      '+y',
    ].join('\r\n');
    expect(patchFiles(patch)).toEqual(['old/gone.ts', 'new/added.ts']);
  });

  test('no headers, no files', () => {
    expect(patchFiles('')).toEqual([]);
    expect(patchFiles('+just a line')).toEqual([]);
  });
});
