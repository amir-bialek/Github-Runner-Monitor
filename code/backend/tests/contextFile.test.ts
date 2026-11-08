import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GitHubAppError, MOCK_CONTEXT_FILE, type ContextFileAnswer } from '../src/adapters/githubApp';
import { loadContextFile, parseContextFile } from '../src/services/debugIt/contextFile';

// Tests run with cwd code/backend, so these are the shipped docs files.
const DOCS = resolve(process.cwd(), '../../docs/debug-context');
const OPTIONS = { organization: 'acme', repository: 'acme/payments-api' };

function appAnswering(answer: ContextFileAnswer | Error) {
  const readContextFile = jest.fn(async (_repository: string) => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return { readContextFile };
}

function extras(...items: string[]): string {
  return `## Extra repositories\n\n${items.map((item) => `- ${item}`).join('\n')}\n`;
}

const FULL = `# Debug context

## About this repo

payments-api takes card payments.

## Common failures

- Integration tests time out.

## Extra repositories

- shared-actions  composite actions
- acme/shared-config
`;

describe('loadContextFile', () => {
  test('a full file returns the three sections and its extra repositories', async () => {
    const app = appAnswering({ status: 'found', text: FULL });
    const outcome = await loadContextFile(app, 'acme/payments-api', 'acme');
    expect(app.readContextFile).toHaveBeenCalledWith('acme/payments-api');
    expect(outcome).toEqual({
      ok: true,
      context: {
        aboutThisRepo: 'payments-api takes card payments.',
        commonFailures: '- Integration tests time out.',
        extraRepositories: ['acme/shared-actions', 'acme/shared-config'],
        skippedRepositories: [],
      },
    });
  });

  test('a missing file is refused with one sentence naming the repository and path', async () => {
    const outcome = await loadContextFile(appAnswering({ status: 'missing' }), 'acme/payments-api', 'acme');
    expect(outcome).toEqual({
      ok: false,
      reason: 'acme/payments-api has no debug context file at .github/claude-debug-context.md on its default branch.',
    });
  });

  test.each(['', '  \n\n', '\t\r\n ﻿'])('an empty file %j is refused', async (text) => {
    const outcome = await loadContextFile(appAnswering({ status: 'found', text }), 'acme/payments-api', 'acme');
    expect(outcome).toEqual({
      ok: false,
      reason: 'acme/payments-api has an empty debug context file at .github/claude-debug-context.md on its default branch.',
    });
  });

  test('a file over 64 KiB is refused', async () => {
    const outcome = await loadContextFile(appAnswering({ status: 'too-large' }), 'acme/payments-api', 'acme');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain('acme/payments-api');
    expect(outcome.reason).toContain('.github/claude-debug-context.md');
    expect(outcome.reason).toMatch(/debug context file .*is larger than 64 KiB\.$/);
  });

  test('every refusal is one sentence', async () => {
    for (const answer of [{ status: 'missing' }, { status: 'too-large' }, { status: 'found', text: ' ' }] as const) {
      const outcome = await loadContextFile(appAnswering(answer), 'acme/payments-api', 'acme');
      if (outcome.ok) throw new Error('expected a refusal');
      expect(outcome.reason.match(/\.(\s|$)/g)).toHaveLength(1);
    }
  });

  test('a GitHub failure surfaces as the adapter error', async () => {
    const app = appAnswering(new GitHubAppError('GitHub did not answer the debug context file request.'));
    await expect(loadContextFile(app, 'acme/payments-api', 'acme')).rejects.toBeInstanceOf(GitHubAppError);
  });
});

describe('parseContextFile sections', () => {
  test('a file with no sections has empty sections and no extras', () => {
    expect(parseContextFile('Just some prose about the repository.\n\n- a list item\n', OPTIONS)).toEqual({
      aboutThisRepo: '',
      commonFailures: '',
      extraRepositories: [],
      skippedRepositories: [],
    });
  });

  test('a missing section is empty while the others are read', () => {
    const context = parseContextFile('## Common failures\n\nFlaky DNS.\n', OPTIONS);
    expect(context.aboutThisRepo).toBe('');
    expect(context.commonFailures).toBe('Flaky DNS.');
  });

  test.each([
    ['# About this repo'],
    ['###### About this repo'],
    ['## ABOUT THIS REPO'],
    ['##   about this repo   '],
    ['## About this repo ##'],
    ['## About this repo #####   '],
    ['   ## About this repo'],
  ])('heading %j is found', (heading) => {
    expect(parseContextFile(`${heading}\n\nIt pays.\n`, OPTIONS).aboutThisRepo).toBe('It pays.');
  });

  test.each([
    ['####### About this repo'],
    ['##About this repo'],
    ['    ## About this repo'],
    ['## About this repository'],
    ['About this repo\n==='],
  ])('%j is not the section heading', (heading) => {
    expect(parseContextFile(`${heading}\n\nIt pays.\n`, OPTIONS).aboutThisRepo).toBe('');
  });

  test('a section ends at the next heading of the same or higher level', () => {
    const text = '## About this repo\nOne.\n### Build\nTwo.\n## Common failures\nThree.\n# Other\nFour.\n';
    const context = parseContextFile(text, OPTIONS);
    expect(context.aboutThisRepo).toBe('One.\n### Build\nTwo.');
    expect(context.commonFailures).toBe('Three.');
  });

  test('a section under a deeper heading ends at a shallower one', () => {
    const text = '# Repo\n### About this repo\nOne.\n## Next\nTwo.\n';
    expect(parseContextFile(text, OPTIONS).aboutThisRepo).toBe('One.');
  });

  test('a heading inside a code fence does not end a section', () => {
    const text = '## Common failures\n```\n## not a heading\n```\nAfter.\n## Extra repositories\n- tools\n';
    const context = parseContextFile(text, OPTIONS);
    expect(context.commonFailures).toBe('```\n## not a heading\n```\nAfter.');
    expect(context.extraRepositories).toEqual(['acme/tools']);
  });

  test('HTML comments are left out of section text', () => {
    const text = '## About this repo\n<!-- guidance\nmore guidance -->\nIt <!-- really --> pays.\n## Common failures\n<!-- only a comment -->\n';
    const context = parseContextFile(text, OPTIONS);
    expect(context.aboutThisRepo).toBe('It  pays.');
    expect(context.commonFailures).toBe('');
  });

  test('Windows line endings are read', () => {
    const context = parseContextFile('## About this repo\r\nIt pays.\r\n## Extra repositories\r\n- tools\r\n', OPTIONS);
    expect(context.aboutThisRepo).toBe('It pays.');
    expect(context.extraRepositories).toEqual(['acme/tools']);
  });
});

describe('parseContextFile extra repositories', () => {
  test('seven in the organization keep the first five and skip the last two as over-limit', () => {
    const context = parseContextFile(extras('r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'), OPTIONS);
    expect(context.extraRepositories).toEqual(['acme/r1', 'acme/r2', 'acme/r3', 'acme/r4', 'acme/r5']);
    expect(context.skippedRepositories).toEqual([
      { entry: 'r6', reason: 'over-limit' },
      { entry: 'r7', reason: 'over-limit' },
    ]);
  });

  test('one outside the organization is skipped and not counted toward five', () => {
    const context = parseContextFile(extras('other-org/tool', 'r1', 'r2', 'r3', 'r4', 'r5'), OPTIONS);
    expect(context.extraRepositories).toHaveLength(5);
    expect(context.skippedRepositories).toEqual([{ entry: 'other-org/tool', reason: 'outside-organization' }]);
  });

  test('a bare name means the organization', () => {
    expect(parseContextFile(extras('shared-actions'), OPTIONS).extraRepositories).toEqual(['acme/shared-actions']);
  });

  test('kept entries use the configured organization spelling', () => {
    expect(parseContextFile(extras('ACME/Shared-Actions'), OPTIONS).extraRepositories).toEqual(['acme/Shared-Actions']);
  });

  test.each(['../etc', 'a/b/c', '..', '.', '/tool', 'acme/', '-acme/tool', 'acme/to:ol', `acme/${'x'.repeat(101)}`])(
    '%j is skipped as invalid-name',
    (entry) => {
      const context = parseContextFile(extras(entry), OPTIONS);
      expect(context.extraRepositories).toEqual([]);
      expect(context.skippedRepositories).toEqual([{ entry, reason: 'invalid-name' }]);
    },
  );

  test('an owner over 39 characters is invalid', () => {
    const entry = `${'a'.repeat(40)}/tool`;
    expect(parseContextFile(extras(entry), OPTIONS).skippedRepositories).toEqual([{ entry, reason: 'invalid-name' }]);
  });

  test('a skipped entry is cut by code points, never splitting an emoji', () => {
    const entry = `${'x'.repeat(199)}\u{1F600}${'y'.repeat(10)}`;
    expect(parseContextFile(extras(entry), OPTIONS).skippedRepositories).toEqual([
      { entry: `${'x'.repeat(199)}\u{1F600}`, reason: 'invalid-name' },
    ]);
  });

  test('a commented-out list item is not kept', () => {
    const text = '## Extra repositories\n<!-- - old-repo -->\n<!--\n- older-repo\n-->\n- tools <!-- note -->\n';
    const context = parseContextFile(text, OPTIONS);
    expect(context.extraRepositories).toEqual(['acme/tools']);
    expect(context.skippedRepositories).toEqual([]);
  });

  test('a backtick fence line inside a tilde fence does not end it', () => {
    const text = '## Extra repositories\n~~~\n```\n- fenced\n```\n~~~\n- one\n';
    expect(parseContextFile(text, OPTIONS).extraRepositories).toEqual(['acme/one']);
  });

  test('a skipped entry is cut to 200 characters', () => {
    const entry = 'x'.repeat(300);
    expect(parseContextFile(extras(entry), OPTIONS).skippedRepositories).toEqual([
      { entry: 'x'.repeat(200), reason: 'invalid-name' },
    ]);
  });

  test('duplicates and the failing repository itself are dropped silently', () => {
    const context = parseContextFile(
      extras('acme/payments-api', 'Payments-API', 'tools', 'ACME/tools', 'other/x', 'Other/X'),
      OPTIONS,
    );
    expect(context.extraRepositories).toEqual(['acme/tools']);
    expect(context.skippedRepositories).toEqual([{ entry: 'other/x', reason: 'outside-organization' }]);
  });

  test('backticks are stripped and text after the name is a comment', () => {
    const context = parseContextFile(extras('`shared-actions` our actions', '`acme/tools`\tthe tools'), OPTIONS);
    expect(context.extraRepositories).toEqual(['acme/shared-actions', 'acme/tools']);
  });

  test('all three list markers are read', () => {
    const text = '## Extra repositories\n- one\n* two\n+ three\n';
    expect(parseContextFile(text, OPTIONS).extraRepositories).toEqual(['acme/one', 'acme/two', 'acme/three']);
  });

  test('only list items directly in the section count', () => {
    const text = [
      '- before',
      '## Extra repositories',
      'Prose naming acme/prose is ignored.',
      '- one',
      '    - nested',
      '1. numbered',
      '```',
      '- fenced',
      '```',
      '-',
      '### More',
      '- under-subheading',
      '## Common failures',
      '- after',
    ].join('\n');
    const context = parseContextFile(text, OPTIONS);
    expect(context.extraRepositories).toEqual(['acme/one']);
    expect(context.skippedRepositories).toEqual([]);
  });
});

describe('shipped docs', () => {
  test('the example parses to two kept extra repositories with nothing skipped', () => {
    const text = readFileSync(resolve(DOCS, 'claude-debug-context.example.md'), 'utf8');
    const context = parseContextFile(text, OPTIONS);
    expect(context.extraRepositories).toEqual(['acme/shared-actions', 'acme/shared-config']);
    expect(context.skippedRepositories).toEqual([]);
    expect(context.aboutThisRepo).not.toBe('');
    expect(context.commonFailures).not.toBe('');
  });

  test('the mock App serves the shipped example', () => {
    expect(MOCK_CONTEXT_FILE).toBe(readFileSync(resolve(DOCS, 'claude-debug-context.example.md'), 'utf8'));
  });

  test('the template has the three sections and lists no repository', () => {
    const text = readFileSync(resolve(DOCS, 'claude-debug-context.template.md'), 'utf8');
    expect(text).toMatch(/^## About this repo$/m);
    expect(text).toMatch(/^## Common failures$/m);
    expect(text).toMatch(/^## Extra repositories$/m);
    const context = parseContextFile(text, OPTIONS);
    expect(context.aboutThisRepo).toBe('');
    expect(context.commonFailures).toBe('');
    expect(context.extraRepositories).toEqual([]);
    expect(context.skippedRepositories).toEqual([]);
  });
});
