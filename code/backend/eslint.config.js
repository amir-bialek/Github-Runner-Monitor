import tseslint from 'typescript-eslint';

const restrictedSdkPatterns = [
  {
    group: ['@octokit/*', 'octokit'],
    message: 'GitHub SDK imports are only allowed in src/adapters/.',
  },
  {
    group: ['@kubernetes/client-node', '@kubernetes/client-node/**'],
    message: 'Kubernetes SDK imports are only allowed in src/adapters/.',
  },
  {
    group: ['@aws-sdk/*'],
    message: 'AWS SDK imports are only allowed in src/adapters/.',
  },
  {
    group: ['@anthropic-ai/*'],
    message: 'Anthropic SDK imports are only allowed in src/adapters/.',
  },
];

// AD-1: only the anthropic adapter may name the Anthropic API host.
const anthropicHostRule = [
  'error',
  {
    selector: 'Literal[value=/api\\.anthropic\\.com/i]',
    message: 'Only src/adapters/ may call api.anthropic.com.',
  },
  {
    selector: 'TemplateElement[value.raw=/api\\.anthropic\\.com/i]',
    message: 'Only src/adapters/ may call api.anthropic.com.',
  },
];

export default [
  { ignores: ['node_modules/**', 'dist/**', 'coverage/**'] },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    rules: {
      'no-restricted-imports': ['error', { patterns: restrictedSdkPatterns }],
    },
  },
  {
    // Existing 1.x files and the future adapter folder may import SDKs.
    files: [
      'src/adapters/**',
      'src/services/statePersistence.ts',
      'src/services/githubClient.ts',
    ],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/adapters/**'],
    rules: { 'no-restricted-syntax': anthropicHostRule },
  },
];
