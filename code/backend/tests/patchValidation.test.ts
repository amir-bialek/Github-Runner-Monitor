import { readFileSync } from 'fs';
import path from 'path';
import {
  PATCH_RULE_MESSAGES,
  patchCheckView,
  validatePatch,
  type PatchRule,
} from '../src/services/debugIt/patchValidation';
import type { RunDownload } from '../src/services/debugIt/runs';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const DOWNLOADS: RunDownload[] = [
  { repository: 'acme/payments-api', commitSha: SHA, folder: 'payments-api' },
  { repository: 'acme/shared-lib', commitSha: SHA, folder: 'shared-lib' },
];
const LIMIT = 102400;

const HUNK = '@@ -1 +1 @@\n-old\n+new\n';
/** A plain --- / +++ section with one hunk. */
const file = (oldPath: string, newPath = oldPath.replace(/^a\//, 'b/')): string => `--- ${oldPath}\n+++ ${newPath}\n${HUNK}`;
const check = (patch: string, limit = LIMIT) => validatePatch(patch, DOWNLOADS, limit);
const ruleOf = (patch: string) => {
  const outcome = check(patch);
  return { status: outcome.status, rule: outcome.rule, repositories: outcome.repositories.map((r) => [r.folder, r.rule]) };
};

describe('validatePatch: the I/O matrix', () => {
  test('clean one-repo patch: passed, files listed', () => {
    const patch = file('a/payments-api/src/db.ts');
    const outcome = check(patch);
    expect(patchCheckView(outcome)).toEqual({
      status: 'passed',
      rule: null,
      message: null,
      repositories: [
        { repository: 'acme/payments-api', folder: 'payments-api', files: ['src/db.ts'], status: 'passed', rule: null, message: null },
      ],
    });
    expect(outcome.repositories[0]!.sections).toEqual([{ oldPath: 'src/db.ts', newPath: 'src/db.ts', text: patch }]);
  });

  test('two repos, one bad: refused overall, the clean one passed', () => {
    const outcome = check(file('a/payments-api/src/db.ts') + file('a/shared-lib/.github/workflows/ci.yml'));
    expect(outcome.status).toBe('refused');
    expect(outcome.rule).toBe('workflow-file');
    expect(outcome.repositories.map((r) => [r.folder, r.status, r.rule, r.files])).toEqual([
      ['payments-api', 'passed', null, ['src/db.ts']],
      ['shared-lib', 'refused', 'workflow-file', ['.github/workflows/ci.yml']],
    ]);
    expect(outcome.repositories[1]!.message).toBe(PATCH_RULE_MESSAGES['workflow-file']);
  });

  test('case trick', () => {
    expect(ruleOf(file('a/payments-api/.GitHub/WorkFlows/x.yml')).rule).toBe('workflow-file');
  });

  test('backslash and dot trick', () => {
    expect(ruleOf(file('a/payments-api/./.github\\workflows/x.yml')).rule).toBe('workflow-file');
  });

  test('invisible characters and a Payments-API folder written in another case', () => {
    expect(ruleOf(file('a/Payments-API/.git\u200bhub/work\ufeffflows/x.yml')).rule).toBe('workflow-file');
  });

  test.each([['a/payments-api/.git/config', 'b/payments-api/.git/config'], ['a/payments-api/sub/.GIT/hooks/x', 'b/payments-api/sub/.GIT/hooks/x']])(
    'git internals: %s',
    (oldPath, newPath) => {
      expect(ruleOf(file(oldPath, newPath)).rule).toBe('git-internals');
    },
  );

  test('rename into workflows', () => {
    const patch =
      'diff --git a/payments-api/a.yml b/payments-api/.github/workflows/a.yml\n' +
      'similarity index 100%\n' +
      'rename from payments-api/a.yml\n' +
      'rename to payments-api/.github/workflows/a.yml\n';
    const outcome = check(patch);
    expect(outcome.rule).toBe('workflow-file');
    expect(outcome.repositories[0]!.files).toEqual(['a.yml', '.github/workflows/a.yml']);
    expect(outcome.repositories[0]!.sections[0]).toMatchObject({ oldPath: 'a.yml', newPath: '.github/workflows/a.yml' });
  });

  test('rename lines that disagree with the diff --git header: unreadable', () => {
    const patch =
      'diff --git a/payments-api/a.yml b/payments-api/b.yml\n' +
      'rename from payments-api/a.yml\n' +
      'rename to payments-api/.github/workflows/b.yml\n';
    expect(ruleOf(patch)).toEqual({ status: 'refused', rule: 'unreadable', repositories: [] });
  });

  test('symlink', () => {
    const patch =
      'diff --git a/payments-api/link b/payments-api/link\n' +
      'new file mode 120000\n' +
      'index 0000000..1234567\n' +
      '--- /dev/null\n' +
      '+++ b/payments-api/link\n' +
      '@@ -0,0 +1 @@\n' +
      '+/etc/passwd\n' +
      '\\ No newline at end of file\n';
    const outcome = check(patch);
    expect(outcome.rule).toBe('symbolic-link');
    expect(outcome.repositories[0]!.sections[0]).toMatchObject({ oldPath: null, newPath: 'link' });
  });

  test('mode change', () => {
    const patch = 'diff --git a/payments-api/run.sh b/payments-api/run.sh\nold mode 100644\nnew mode 100755\n';
    expect(ruleOf(patch)).toEqual({ status: 'refused', rule: 'file-mode', repositories: [['payments-api', 'file-mode']] });
  });

  test('parent escape', () => {
    expect(ruleOf(file('a/payments-api/x', 'b/payments-api/../etc/passwd')).rule).toBe('outside-repository');
  });

  test('no prefix', () => {
    expect(ruleOf(file('a/payments-api/x', 'payments-api/x')).rule).toBe('outside-repository');
  });

  test('unknown folder: whole patch outside-downloads, other repositories take it', () => {
    const outcome = check(file('a/payments-api/src/db.ts') + file('a/other-repo/x'));
    expect(outcome.status).toBe('refused');
    expect(outcome.rule).toBe('outside-downloads');
    expect(outcome.message).toBe(PATCH_RULE_MESSAGES['outside-downloads']);
    expect(outcome.repositories.map((r) => [r.folder, r.rule])).toEqual([['payments-api', 'outside-downloads']]);
    expect(ruleOf(file('a/other-repo/x', 'b/other-repo/x'))).toEqual({ status: 'refused', rule: 'outside-downloads', repositories: [] });
  });

  test('a repository keeps its own first rule before the whole-patch rule', () => {
    const outcome = check(file('a/payments-api/.github/workflows/ci.yml') + file('a/other-repo/x'));
    expect(outcome.rule).toBe('outside-downloads');
    expect(outcome.repositories.map((r) => [r.folder, r.rule])).toEqual([['payments-api', 'workflow-file']]);
  });

  test('over limit: 100 KB + 1 byte with limit 102400', () => {
    const header = '--- a/payments-api/big.txt\n+++ b/payments-api/big.txt\n@@ -1 +1 @@\n-x\n+';
    const patch = header + 'y'.repeat(102401 - header.length - 1) + '\n';
    expect(Buffer.byteLength(patch)).toBe(102401);
    const outcome = check(patch);
    expect(outcome.rule).toBe('too-large');
    expect(outcome.repositories.map((r) => [r.folder, r.rule])).toEqual([['payments-api', 'too-large']]);
    expect(check(patch, 102401).status).toBe('passed');
  });

  test('a 51-byte patch with a 50-byte limit is too-large', () => {
    const downloads = [{ repository: 'acme/p', commitSha: SHA, folder: 'p' }];
    const patch = '--- a/p/a\n+++ b/p/a\n@@ -1 +1 @@\n-x\n+y\n'.padEnd(51, '\n');
    expect(Buffer.byteLength(patch)).toBe(51);
    expect(validatePatch(patch, downloads, 50).rule).toBe('too-large');
    expect(validatePatch(patch, downloads, 51).status).toBe('passed');
  });

  test('multi-byte characters count as bytes', () => {
    const patch = `--- a/payments-api/a\n+++ b/payments-api/a\n@@ -1 +1 @@\n-x\n+${'\u00e9'.repeat(20)}\n`;
    expect(patch.length).toBeLessThanOrEqual(80);
    expect(check(patch, patch.length).rule).toBe('too-large');
  });

  test.each([
    ['binary', 'diff --git a/payments-api/x.png b/payments-api/x.png\nBinary files a/payments-api/x.png and b/payments-api/x.png differ\n'],
    ['git binary', 'diff --git a/payments-api/x.png b/payments-api/x.png\nGIT binary patch\nliteral 3\nabc\n'],
    ['garbage', 'please apply this fix\n'],
    ['too few hunk lines', '--- a/payments-api/x\n+++ b/payments-api/x\n@@ -1,2 +1,2 @@\n-old\n+new\n'],
    ['too many hunk lines', '--- a/payments-api/x\n+++ b/payments-api/x\n@@ -1 +1 @@\n-old\n+new\n+extra\n'],
    ['no hunk', '--- a/payments-api/x\n+++ b/payments-api/x\n'],
    ['no +++', '--- a/payments-api/x\n@@ -1 +1 @@\n-old\n+new\n'],
    ['empty hunk', '--- a/payments-api/x\n+++ b/payments-api/x\n@@ -0,0 +0,0 @@\n'],
    ['hunk first', '@@ -1 +1 @@\n-old\n+new\n'],
    ['empty line inside', `${file('a/payments-api/x')}\n${file('a/payments-api/y')}`],
    ['both sides /dev/null', '--- /dev/null\n+++ /dev/null\n@@ -0,0 +1 @@\n+x\n'],
    ['git header with no name', 'diff --git x y\nold mode 100644\nnew mode 100755\n'],
    ['unknown extended header', 'diff --git a/payments-api/x b/payments-api/x\nmystery header\n'],
  ])('unreadable (%s): no repositories', (_name, patch) => {
    const outcome = check(patch);
    expect(patchCheckView(outcome)).toEqual({
      status: 'refused',
      rule: 'unreadable',
      message: PATCH_RULE_MESSAGES.unreadable,
      repositories: [],
    });
  });

  test('a hunk line that looks like a header is content', () => {
    const patch =
      '--- a/payments-api/notes.md\n+++ b/payments-api/notes.md\n' +
      '@@ -1,2 +1,2 @@\n' +
      '--- a/payments-api/.github/workflows/ci.yml\n' +
      '+++ b/payments-api/.git/config\n' +
      ' diff --git a/x b/x\n';
    const outcome = check(patch);
    expect(outcome.status).toBe('passed');
    expect(outcome.repositories[0]!.files).toEqual(['notes.md']);
  });

  test('a header hidden after the counted lines is a new section and is checked', () => {
    const patch =
      '--- a/payments-api/notes.md\n+++ b/payments-api/notes.md\n@@ -1 +1 @@\n-a\n+b\n' + file('a/payments-api/.github/workflows/ci.yml');
    expect(ruleOf(patch).rule).toBe('workflow-file');
  });

  test.each([[''], ['\n\n']])('empty patch %j', (patch) => {
    expect(check(patch)).toEqual({ status: 'empty', rule: null, message: null, repositories: [] });
  });
});

describe('validatePatch: one refused patch per rule', () => {
  const cases: Array<[PatchRule, string, number?]> = [
    ['too-large', file('a/payments-api/x'), 10],
    ['unreadable', 'GIT binary patch\n'],
    ['outside-downloads', file('a/elsewhere/x')],
    ['outside-repository', file('a/payments-api/x', 'b/shared-lib/x')],
    ['git-internals', file('a/payments-api/.git/hooks/pre-commit')],
    ['workflow-file', file('a/payments-api/.github/workflows/ci.yml')],
    ['symbolic-link', 'diff --git a/payments-api/l b/payments-api/l\nindex 1234567..89abcde 120000\n--- a/payments-api/l\n+++ b/payments-api/l\n' + HUNK],
    ['file-mode', 'diff --git a/payments-api/x b/payments-api/x\nnew file mode 100755\n--- /dev/null\n+++ b/payments-api/x\n@@ -0,0 +1 @@\n+x\n'],
  ];
  // A default keeps the function length at 2, so Jest does not take limit for done.
  test.each(cases)('%s', (rule, patch, limit = LIMIT) => {
    const outcome = check(patch, limit);
    expect(outcome.status).toBe('refused');
    expect(outcome.rule).toBe(rule);
    expect(outcome.message).toBe(PATCH_RULE_MESSAGES[rule]);
  });

  test('every rule has its own sentence; the workflow one says to apply it by hand', () => {
    expect(new Set(Object.values(PATCH_RULE_MESSAGES)).size).toBe(8);
    expect(PATCH_RULE_MESSAGES['workflow-file']).toMatch(/cannot be changed by Debug it/);
    expect(PATCH_RULE_MESSAGES['workflow-file']).toMatch(/by hand/);
  });
});

describe('validatePatch: more path rules', () => {
  test.each([
    ['absolute after the prefix', file('a/payments-api/x', 'b//payments-api/x')],
    ['folder only', file('a/payments-api/x', 'b/payments-api/')],
    ['control character', file('a/payments-api/x', 'b/payments-api/x\u0007y')],
    ['dot-dot hidden by an invisible character', file('a/payments-api/x', 'b/payments-api/.\u200b./x')],
    ['git header with a parent escape', `diff --git a/payments-api/x b/payments-api/../x\n${file('a/payments-api/x', 'b/payments-api/../x')}`],
    ['copy across folders', 'diff --git a/payments-api/x b/shared-lib/x\ncopy from payments-api/x\ncopy to shared-lib/x\n'],
  ])('%s: outside-repository', (_name, patch) => {
    expect(ruleOf(patch).rule).toBe('outside-repository');
  });

  test('the wrong prefix on the old side is refused', () => {
    expect(ruleOf(file('b/payments-api/x', 'b/payments-api/x')).rule).toBe('outside-downloads');
  });

  test('a cross-folder rename refuses both repositories', () => {
    const patch = 'diff --git a/payments-api/x b/shared-lib/x\nrename from payments-api/x\nrename to shared-lib/x\n';
    expect(ruleOf(patch).repositories).toEqual([
      ['payments-api', 'outside-repository'],
      ['shared-lib', 'outside-repository'],
    ]);
  });

  test('a /tmp/x style absolute path is outside the downloads', () => {
    expect(ruleOf(file('a/payments-api/x', '/payments-api/x')).rule).toBe('outside-repository');
    expect(ruleOf(file('/etc/passwd', '/etc/passwd')).rule).toBe('outside-downloads');
  });

  test.each([['160000'], ['100664'], ['040000']])('mode %s is a file-mode', (mode) => {
    const patch = `diff --git a/payments-api/x b/payments-api/x\ndeleted file mode ${mode}\n--- a/payments-api/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n`;
    expect(ruleOf(patch).rule).toBe('file-mode');
  });

  test('deleting a regular file passes, deleting a symlink does not', () => {
    const del = (mode: string) =>
      `diff --git a/payments-api/x b/payments-api/x\ndeleted file mode ${mode}\nindex 1234567..0000000\n--- a/payments-api/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n`;
    const outcome = check(del('100755'));
    expect(outcome.status).toBe('passed');
    expect(outcome.repositories[0]!.sections[0]).toMatchObject({ oldPath: 'x', newPath: null });
    expect(ruleOf(del('120000')).rule).toBe('symbolic-link');
  });

  test('path text ends at the first tab', () => {
    const outcome = check('--- a/payments-api/x\t2026-11-06\n+++ b/payments-api/x\t2026-11-06\n' + HUNK);
    expect(outcome.status).toBe('passed');
    expect(outcome.repositories[0]!.files).toEqual(['x']);
  });

  test('a .github file outside workflows passes', () => {
    expect(check(file('a/payments-api/.github/CODEOWNERS')).status).toBe('passed');
  });

  test('files are unique and in patch order, and the no-newline marker is read', () => {
    const patch =
      file('a/payments-api/b.ts') +
      'diff --git a/payments-api/a.ts b/payments-api/a.ts\nindex 1234567..89abcde 100644\n--- a/payments-api/a.ts\n+++ b/payments-api/a.ts\n' +
      '@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n' +
      file('a/payments-api/b.ts');
    const outcome = check(patch);
    expect(outcome.status).toBe('passed');
    expect(outcome.repositories[0]!.files).toEqual(['b.ts', 'a.ts']);
    expect(outcome.repositories[0]!.sections.map((s) => s.text).join('')).toBe(patch);
  });
});

describe('patchValidation source', () => {
  test('imports nothing from child_process, fs or a git library, and never logs', () => {
    const source = readFileSync(path.resolve(__dirname, '../src/services/debugIt/patchValidation.ts'), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports).toEqual(['./runs.ts']);
    expect(source).toMatch(/import type \{ RunDownload \} from '\.\/runs\.ts'/);
    expect(source).not.toMatch(/child_process|node:fs|require\(|console\./);
  });
});

describe('validatePatch: review fixes', () => {
  test('a two-hunk section in the unifiedHunks shape passes and keeps its text', () => {
    const patch =
      '--- a/payments-api/src/db.ts\n+++ b/payments-api/src/db.ts\n' +
      '@@ -2,7 +2,7 @@\n l2\n l3\n l4\n-old5\n+new5\n l6\n l7\n l8\n' +
      '@@ -15,7 +15,7 @@\n l15\n l16\n l17\n-old18\n+new18\n l19\n l20\n l21\n';
    const outcome = check(patch);
    expect(outcome.status).toBe('passed');
    expect(outcome.repositories[0]!.files).toEqual(['src/db.ts']);
    expect(outcome.repositories[0]!.sections).toEqual([{ oldPath: 'src/db.ts', newPath: 'src/db.ts', text: patch }]);
  });

  test('a wrapper-shaped added file passes', () => {
    const outcome = check('--- /dev/null\n+++ b/payments-api/new.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n');
    expect(outcome.status).toBe('passed');
    expect(outcome.repositories[0]!.sections[0]).toMatchObject({ oldPath: null, newPath: 'new.ts' });
  });

  test.each([
    ['an invisible character', 'b/payments-api/src/d\u200bb.ts'],
    ['a backslash', 'b/payments-api/src\\db.ts'],
    ['a dot segment', 'b/payments-api/./src/db.ts'],
    ['a double slash', 'b/payments-api/src//db.ts'],
    ['a decomposed character', 'b/payments-api/src/cafe\u0301.ts'],
  ])('a path whose raw text differs from the checked one (%s): outside-repository', (_name, newPath) => {
    const oldPath = `a/${newPath.slice(2)}`;
    expect(ruleOf(file(oldPath, newPath)).rule).toBe('outside-repository');
  });

  test('the folder may be written in another case', () => {
    const outcome = check(file('a/Payments-API/src/db.ts'));
    expect(outcome.status).toBe('passed');
    expect(outcome.repositories[0]!.files).toEqual(['src/db.ts']);
  });

  test.each([
    ['.git.'],
    ['.git '],
    ['.git. .'],
    ['GIT~1'],
    ['.g\u206ait'],
  ])('git-internals for the segment %j', (segment) => {
    expect(ruleOf(file(`a/payments-api/${segment}/config`)).rule).toBe('git-internals');
  });

  test.each([
    ['diff --git and --- name different files', 'diff --git a/payments-api/x b/payments-api/x\n' + file('a/payments-api/y', 'b/payments-api/x')],
    ['diff --git and +++ name different files', 'diff --git a/payments-api/x b/payments-api/x\n' + file('a/payments-api/x', 'b/payments-api/y')],
    ['rename from disagrees with diff --git', 'diff --git a/payments-api/x b/payments-api/y\nrename from payments-api/z\nrename to payments-api/y\n'],
    ['copy to disagrees with +++', 'diff --git a/payments-api/x b/payments-api/y\ncopy from payments-api/x\ncopy to payments-api/y\n' + file('a/payments-api/x', 'b/payments-api/z')],
    ['new file mode with an old file', 'diff --git a/payments-api/x b/payments-api/x\nnew file mode 100644\n' + file('a/payments-api/x')],
    ['deleted file mode with a new file', 'diff --git a/payments-api/x b/payments-api/x\ndeleted file mode 100644\n' + file('a/payments-api/x')],
    ['a diff --git that changes nothing', 'diff --git a/payments-api/x b/payments-api/x\n'],
    ['rename from without rename to', 'diff --git a/payments-api/x b/payments-api/y\nrename from payments-api/x\n'],
    ['rename to without rename from', 'diff --git a/payments-api/x b/payments-api/y\nrename to payments-api/y\n'],
    ['copy from without copy to', 'diff --git a/payments-api/x b/payments-api/y\ncopy from payments-api/x\n'],
  ])('unreadable: %s', (_name, patch) => {
    expect(ruleOf(patch)).toEqual({ status: 'refused', rule: 'unreadable', repositories: [] });
  });

  test('a consistent rename with ---/+++ passes', () => {
    const patch =
      'diff --git a/payments-api/x b/payments-api/y\nsimilarity index 90%\nrename from payments-api/x\nrename to payments-api/y\n' +
      file('a/payments-api/x', 'b/payments-api/y');
    expect(check(patch).status).toBe('passed');
  });

  test('the file-mode sentence covers a mode change and a new file other than 100644', () => {
    expect(PATCH_RULE_MESSAGES['file-mode']).toMatch(/changes a file mode/);
    expect(PATCH_RULE_MESSAGES['file-mode']).toMatch(/other than 100644/);
    expect(PATCH_RULE_MESSAGES['file-mode']).not.toMatch(/not a regular file/);
  });
});
