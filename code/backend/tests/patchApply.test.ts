import { applySection, isCopySection, PatchApplyError } from '../src/services/debugIt/patchApply';
import { validatePatch } from '../src/services/debugIt/patchValidation';
import { unifiedHunks } from '../../debug-job/src/diff';

const DOWNLOADS = [{ repository: 'acme/payments-api', commitSha: 'a'.repeat(40), folder: 'payments-api' }];

// The sections exactly as story 4.1 hands them over.
function sections(patch: string) {
  const check = validatePatch(patch, DOWNLOADS, 1024 * 1024);
  expect(check.status).toBe('passed');
  return check.repositories[0]!.sections;
}

function only(patch: string) {
  const all = sections(patch);
  expect(all).toHaveLength(1);
  return all[0]!;
}

describe('applySection', () => {
  test('an edit replaces the stated lines and keeps the rest', () => {
    const original = 'one\ntwo\nthree\nfour\nfive\n';
    const section = only(
      'diff --git a/payments-api/src/a.txt b/payments-api/src/a.txt\n--- a/payments-api/src/a.txt\n+++ b/payments-api/src/a.txt\n@@ -2,3 +2,3 @@\n two\n-three\n+THREE\n four\n',
    );
    expect(section).toMatchObject({ oldPath: 'src/a.txt', newPath: 'src/a.txt' });
    expect(applySection(original, section.text)).toBe('one\ntwo\nTHREE\nfour\nfive\n');
  });

  test('several hunks apply in order', () => {
    const original = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const text =
      '--- a/payments-api/f\n+++ b/payments-api/f\n@@ -2 +2 @@\n-line 2\n+LINE 2\n@@ -15,2 +15,3 @@\n line 15\n+inserted\n line 16\n';
    const result = applySection(original, only(text).text)!;
    expect(result.split('\n')[1]).toBe('LINE 2');
    expect(result.split('\n').slice(14, 17)).toEqual(['line 15', 'inserted', 'line 16']);
    expect(result.split('\n')).toHaveLength(22);
  });

  test('an added file: the original must not exist', () => {
    const section = only(
      'diff --git a/payments-api/new.txt b/payments-api/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/payments-api/new.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n',
    );
    expect(section).toMatchObject({ oldPath: null, newPath: 'new.txt' });
    expect(applySection(null, section.text)).toBe('hello\nworld\n');
    expect(() => applySection('already here\n', section.text)).toThrow(PatchApplyError);
  });

  test('a deleted file answers null; it must exist and hold exactly the removed lines', () => {
    const section = only(
      'diff --git a/payments-api/old.txt b/payments-api/old.txt\ndeleted file mode 100644\n--- a/payments-api/old.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n',
    );
    expect(section).toMatchObject({ oldPath: 'old.txt', newPath: null });
    expect(applySection('a\nb\n', section.text)).toBeNull();
    expect(() => applySection(null, section.text)).toThrow(PatchApplyError);
    expect(() => applySection('a\nb\nc\n', section.text)).toThrow(PatchApplyError);
  });

  test('a changed file must exist', () => {
    const section = only('--- a/payments-api/f\n+++ b/payments-api/f\n@@ -1 +1 @@\n-old\n+new\n');
    expect(() => applySection(null, section.text)).toThrow(PatchApplyError);
  });

  test('a pure rename keeps the text; a rename with a hunk applies it', () => {
    const pure = only(
      'diff --git a/payments-api/a.txt b/payments-api/b.txt\nsimilarity index 100%\nrename from payments-api/a.txt\nrename to payments-api/b.txt\n',
    );
    expect(pure).toMatchObject({ oldPath: 'a.txt', newPath: 'b.txt' });
    expect(applySection('same\n', pure.text)).toBe('same\n');
    expect(isCopySection(pure.text)).toBe(false);

    const edited = only(
      'diff --git a/payments-api/a.txt b/payments-api/b.txt\nsimilarity index 80%\nrename from payments-api/a.txt\nrename to payments-api/b.txt\n--- a/payments-api/a.txt\n+++ b/payments-api/b.txt\n@@ -1,2 +1,2 @@\n keep\n-x\n+y\n',
    );
    expect(applySection('keep\nx\n', edited.text)).toBe('keep\ny\n');
  });

  test('a copy is recognized so its source stays', () => {
    const copy = only(
      'diff --git a/payments-api/a.txt b/payments-api/c.txt\nsimilarity index 100%\ncopy from payments-api/a.txt\ncopy to payments-api/c.txt\n',
    );
    expect(isCopySection(copy.text)).toBe(true);
  });

  test('\\ No newline at end of file: removed on the new side', () => {
    const section = only(
      '--- a/payments-api/f\n+++ b/payments-api/f\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n',
    );
    expect(applySection('a\nb', section.text)).toBe('a\nb\n');
    // The original must really end without a newline.
    expect(() => applySection('a\nb\n', section.text)).toThrow(PatchApplyError);
  });

  test('\\ No newline at end of file: added on the new side', () => {
    const section = only(
      '--- a/payments-api/f\n+++ b/payments-api/f\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n\\ No newline at end of file\n',
    );
    expect(applySection('a\nb\n', section.text)).toBe('a\nc');
  });

  test('\\ No newline at end of file on a context line keeps both sides without one', () => {
    const section = only(
      '--- a/payments-api/f\n+++ b/payments-api/f\n@@ -1,2 +1,2 @@\n-a\n+A\n b\n\\ No newline at end of file\n',
    );
    expect(applySection('a\nb', section.text)).toBe('A\nb');
  });

  test('a last line without newline must be marked in the hunk', () => {
    const section = only('--- a/payments-api/f\n+++ b/payments-api/f\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n');
    expect(() => applySection('a\nb', section.text)).toThrow(PatchApplyError);
  });

  test('CRLF lines keep their carriage return and compare exactly', () => {
    const section = only('--- a/payments-api/f\n+++ b/payments-api/f\n@@ -1,2 +1,2 @@\n a\r\n-b\r\n+c\r\n');
    expect(applySection('a\r\nb\r\n', section.text)).toBe('a\r\nc\r\n');
    // An LF file does not match CRLF context.
    expect(() => applySection('a\nb\n', section.text)).toThrow(PatchApplyError);
  });

  test('a mismatch refuses: no fuzz, no moving a hunk', () => {
    const section = only('--- a/payments-api/f\n+++ b/payments-api/f\n@@ -2,2 +2,2 @@\n two\n-three\n+THREE\n');
    expect(() => applySection('one\ntwo\nthree\n', section.text)).not.toThrow();
    // The same lines one line further down are not found.
    expect(() => applySection('zero\none\ntwo\nthree\n', section.text)).toThrow(PatchApplyError);
    // Changed context.
    expect(() => applySection('one\nTWO\nthree\n', section.text)).toThrow(PatchApplyError);
    // A file too short.
    expect(() => applySection('one\n', section.text)).toThrow(PatchApplyError);
  });

  test('the original is not changed (pure)', () => {
    const original = 'a\nb\n';
    const section = only('--- a/payments-api/f\n+++ b/payments-api/f\n@@ -1 +1 @@\n-a\n+z\n');
    expect(applySection(original, section.text)).toBe('z\nb\n');
    expect(original).toBe('a\nb\n');
  });
});

describe('applySection with the Debug Job wrapper diff', () => {
  // A small deterministic generator, so a failure is reproducible.
  function random(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
  }

  function text(next: () => number, from: string[]): string {
    const lines = Array.from({ length: Math.floor(next() * 12) }, () => from[Math.floor(next() * from.length)]!);
    const body = lines.join('\n');
    return body === '' ? '' : next() < 0.3 ? body : `${body}\n`;
  }

  test('every change the wrapper writes applies back exactly', () => {
    const next = random(42);
    const words = ['a', 'b', 'c', 'd\r', 'e', ''];
    for (let i = 0; i < 400; i += 1) {
      const before = text(next, words);
      const after = text(next, words);
      const hunks = unifiedHunks(before, after);
      if (hunks === '') continue;
      const header =
        before === ''
          ? 'diff --git a/payments-api/f b/payments-api/f\nnew file mode 100644\n--- /dev/null\n+++ b/payments-api/f\n'
          : after === ''
            ? 'diff --git a/payments-api/f b/payments-api/f\ndeleted file mode 100644\n--- a/payments-api/f\n+++ /dev/null\n'
            : '--- a/payments-api/f\n+++ b/payments-api/f\n';
      const section = only(header + hunks);
      expect(applySection(before === '' ? null : before, section.text)).toBe(after === '' ? null : after);
    }
  });
});
