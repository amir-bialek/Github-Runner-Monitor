import { spawnSync } from 'child_process';
import path from 'path';

const root = path.resolve(__dirname, '..');
const eslintBin = path.join(root, 'node_modules', 'eslint', 'bin', 'eslint.js');

// Runs the real ESLint CLI (Jest cannot dynamic-import the flat config).
async function lint(filePath: string, code: string) {
  const res = spawnSync(
    process.execPath,
    [eslintBin, '--stdin', '--stdin-filename', filePath, '--format', 'json'],
    { cwd: root, input: code, encoding: 'utf8' },
  );
  if (res.error || !res.stdout) {
    throw new Error(`ESLint did not run: ${res.error ?? res.stderr}`);
  }
  const [result] = JSON.parse(res.stdout) as Array<{
    messages: Array<{ ruleId: string | null; fatal?: boolean }>;
  }>;
  if (!result || result.messages.some((m) => m.fatal)) {
    throw new Error('ESLint could not lint the input');
  }
  return result.messages.filter((m) => m.ruleId === 'no-restricted-imports');
}

jest.setTimeout(30000);

describe('no-restricted-imports for SDKs', () => {
  const imports = [
    "import { Octokit } from '@octokit/rest';",
    "import { KubeConfig } from '@kubernetes/client-node';",
    "import { S3Client } from '@aws-sdk/client-s3';",
    "import Anthropic from '@anthropic-ai/sdk';",
  ];

  it.each(imports)('rejects outside adapters: %s', async (code) => {
    expect(await lint('src/services/other.ts', code)).toHaveLength(1);
  });

  it.each(imports)('accepts inside adapters: %s', async (code) => {
    expect(await lint('src/adapters/x.ts', code)).toHaveLength(0);
  });

  it.each([
    'src/services/statePersistence.ts',
    'src/services/githubClient.ts',
  ])('accepts in exempt file %s', async (file) => {
    expect(await lint(file, imports.join('\n'))).toHaveLength(0);
  });
});

describe('api.anthropic.com only in adapters (AD-1)', () => {
  async function lintSyntax(filePath: string, code: string) {
    const res = spawnSync(
      process.execPath,
      [eslintBin, '--stdin', '--stdin-filename', filePath, '--format', 'json'],
      { cwd: root, input: code, encoding: 'utf8' },
    );
    const [result] = JSON.parse(res.stdout) as Array<{ messages: Array<{ ruleId: string | null }> }>;
    return result!.messages.filter((m) => m.ruleId === 'no-restricted-syntax');
  }

  const literals = [
    "const url = 'https://api.anthropic.com/v1/models';",
    'const url = `https://api.anthropic.com/v1/${"models"}`;',
  ];

  it.each(literals)('rejects outside adapters: %s', async (code) => {
    expect(await lintSyntax('src/services/debugIt/other.ts', code)).toHaveLength(1);
  });

  it.each(literals)('accepts inside adapters: %s', async (code) => {
    expect(await lintSyntax('src/adapters/anthropic.ts', code)).toHaveLength(0);
  });
});
