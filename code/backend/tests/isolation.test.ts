import { createMockGitHubApp, GitHubAppError, resetGitHubApp, type GitHubApp } from '../src/adapters/githubApp';
import {
  KubernetesError,
  resetIsolationCheckRunner,
  type CheckOutcome,
  type IsolationCheckRunner,
} from '../src/adapters/kubernetes';
import {
  createIsolationGate,
  getIsolationGate,
  ISOLATION_REASONS,
  resetIsolationGate,
  type IsolationStatus,
} from '../src/services/debugIt/isolation';

const NOW = new Date('2026-11-05T10:02:00.000Z');
const log = console.log as jest.Mock;

function githubApp(forbidden: string[] | Error): GitHubApp {
  const mock = createMockGitHubApp();
  return {
    ...mock,
    checkInstallation: jest.fn(async () => {
      if (forbidden instanceof Error) throw forbidden;
      return { installationId: 42, permissions: { contents: 'read' }, forbidden };
    }),
  };
}

function runner(outcome: CheckOutcome | Error): IsolationCheckRunner & { run: jest.Mock } {
  return {
    run: jest.fn(async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }),
  };
}

function gate(forbidden: string[] | Error, outcome: CheckOutcome | Error) {
  const app = githubApp(forbidden);
  const check = runner(outcome);
  const isolation = createIsolationGate({ githubApp: () => app, checkRunner: () => check, now: () => NOW });
  return { isolation, app, check };
}

function audits(): string[] {
  return log.mock.calls.map((a) => a.join(' ')).filter((l) => l.startsWith('[AUDIT] Debug it isolation check'));
}

beforeEach(() => {
  log.mockClear();
  resetIsolationGate();
  resetGitHubApp();
  resetIsolationCheckRunner();
});

describe('createIsolationGate', () => {
  test('starts in checking with the checking reason', () => {
    const { isolation } = gate([], { status: 'passed' });
    expect(isolation.status()).toEqual({ state: 'checking', reason: ISOLATION_REASONS.checking, checkedAt: null });
  });

  test('both checks pass: on, no reason, checked at set', async () => {
    const { isolation, check } = gate([], { status: 'passed' });
    const expected: IsolationStatus = { state: 'on', reason: null, checkedAt: '2026-11-05T10:02:00.000Z' };
    expect(await isolation.run()).toEqual(expected);
    expect(isolation.status()).toEqual(expected);
    expect(check.run).toHaveBeenCalledTimes(1);
    expect(audits()).toEqual(['[AUDIT] Debug it isolation check: on']);
  });

  test('a forbidden permission turns it off and creates no Job', async () => {
    const { isolation, check } = gate(['workflows'], { status: 'passed' });
    const status = await isolation.run();
    expect(status).toEqual({
      state: 'off',
      reason: 'Debug it is off because the Debug it GitHub App has the workflows permission, which it must not have.',
      checkedAt: '2026-11-05T10:02:00.000Z',
    });
    expect(check.run).not.toHaveBeenCalled();
    expect(audits()).toEqual([`[AUDIT] Debug it isolation check: off (${status.reason})`]);
  });

  test('two forbidden permissions are named together', async () => {
    const { isolation, check } = gate(['workflows', 'administration'], { status: 'passed' });
    expect((await isolation.run()).reason).toBe(
      'Debug it is off because the Debug it GitHub App has the workflows and administration permissions, which it must not have.',
    );
    expect(check.run).not.toHaveBeenCalled();
  });

  test('three forbidden permissions are listed with commas and and', async () => {
    const { isolation } = gate(['workflows', 'administration', 'organization_administration'], { status: 'passed' });
    expect((await isolation.run()).reason).toBe(
      'Debug it is off because the Debug it GitHub App has the workflows, administration and organization_administration permissions, which it must not have.',
    );
  });

  test('an unreadable installation turns it off and creates no Job', async () => {
    const { isolation, check } = gate(new GitHubAppError('GitHub did not answer the installation request.'), {
      status: 'passed',
    });
    expect(await isolation.run()).toEqual({
      state: 'off',
      reason: ISOLATION_REASONS.installationUnreadable,
      checkedAt: '2026-11-05T10:02:00.000Z',
    });
    expect(check.run).not.toHaveBeenCalled();
  });

  test('a GitHub App that is not configured counts as unreadable', async () => {
    const check = runner({ status: 'passed' });
    const isolation = createIsolationGate({
      githubApp: () => {
        throw new GitHubAppError('The Debug it GitHub App or the GitHub organization is not configured.');
      },
      checkRunner: () => check,
      now: () => NOW,
    });
    expect((await isolation.run()).reason).toBe(ISOLATION_REASONS.installationUnreadable);
    expect(check.run).not.toHaveBeenCalled();
  });

  test.each<[string, CheckOutcome, string]>([
    ['exit 3', { status: 'failed', exitCode: 3 }, ISOLATION_REASONS.forbiddenReached],
    ['exit 4', { status: 'failed', exitCode: 4 }, ISOLATION_REASONS.anthropicUnreached],
    ['exit 5', { status: 'failed', exitCode: 5 }, ISOLATION_REASONS.both],
    ['exit 1', { status: 'failed', exitCode: 1 }, ISOLATION_REASONS.failed],
    ['exit 2', { status: 'failed', exitCode: 2 }, ISOLATION_REASONS.failed],
    ['an unreadable exit code', { status: 'failed', exitCode: null }, ISOLATION_REASONS.failed],
    ['a timeout', { status: 'timeout' }, ISOLATION_REASONS.timeout],
    ['a Job that was not created', { status: 'not-started' }, ISOLATION_REASONS.notStarted],
  ])('%s turns it off with the matching reason', async (_name, outcome, reason) => {
    const { isolation } = gate([], outcome);
    expect(await isolation.run()).toEqual({ state: 'off', reason, checkedAt: '2026-11-05T10:02:00.000Z' });
  });

  test('a check runner that is not configured: not started', async () => {
    const isolation = createIsolationGate({
      githubApp: () => githubApp([]),
      checkRunner: () => {
        throw new KubernetesError('The isolation check Job template, image tag or namespace is not configured.');
      },
      now: () => NOW,
    });
    expect((await isolation.run()).reason).toBe(ISOLATION_REASONS.notStarted);
  });

  test('a runner that rejects never makes run() reject', async () => {
    const { isolation } = gate([], new Error('boom with invented-secret-marker'));
    const status = await isolation.run();
    expect(status).toEqual({ state: 'off', reason: ISOLATION_REASONS.failed, checkedAt: '2026-11-05T10:02:00.000Z' });
    expect(audits().join('\n')).not.toContain('invented-secret-marker');
  });

  test('concurrent and later run() calls share one check', async () => {
    let finish: (outcome: CheckOutcome) => void = () => undefined;
    const check = { run: jest.fn(() => new Promise<CheckOutcome>((done) => (finish = done))) };
    const isolation = createIsolationGate({ githubApp: () => githubApp([]), checkRunner: () => check, now: () => NOW });
    const first = isolation.run();
    const second = isolation.run();
    expect(second).toBe(first);
    await new Promise((done) => setImmediate(done));
    expect(isolation.status().state).toBe('checking');
    finish({ status: 'passed' });
    expect((await first).state).toBe('on');
    expect(await isolation.run()).toEqual(await first);
    expect(check.run).toHaveBeenCalledTimes(1);
    expect(audits()).toHaveLength(1);
  });

  test('status() answers a copy', async () => {
    const { isolation } = gate([], { status: 'passed' });
    await isolation.run();
    const status = isolation.status();
    status.state = 'off';
    expect(isolation.status().state).toBe('on');
  });

  test('every reason is one sentence', () => {
    const reasons = [
      ...Object.values(ISOLATION_REASONS).filter((r) => typeof r === 'string'),
      ISOLATION_REASONS.forbidden(['workflows']),
      ISOLATION_REASONS.forbidden(['workflows', 'administration']),
    ];
    for (const reason of reasons) {
      expect(reason).toMatch(/^Debug it is off [^.]*\.$/);
    }
  });
});

describe('getIsolationGate', () => {
  test('one gate per process, checking until run', () => {
    const gateA = getIsolationGate({ USE_MOCK_DATA: 'true' });
    expect(getIsolationGate({ USE_MOCK_DATA: 'true' })).toBe(gateA);
    expect(gateA.status().state).toBe('checking');
    resetIsolationGate();
    expect(getIsolationGate({ USE_MOCK_DATA: 'true' })).not.toBe(gateA);
  });

  test('mock mode passes without a cluster', async () => {
    expect((await getIsolationGate({ USE_MOCK_DATA: 'true' }).run()).state).toBe('on');
  });

  test('without configuration it turns off with a fixed reason', async () => {
    const status = await getIsolationGate({}).run();
    expect(status.state).toBe('off');
    expect(status.reason).toBe(ISOLATION_REASONS.installationUnreadable);
  });
});

describe('organization key subscription token (story 5.1)', () => {
  const TOKEN = 'sk-ant-oat01-acme-subscription-token-0000';

  test.each([TOKEN, 'sk-ant-ort01-acme-refresh-token-0000', ` ${TOKEN}`])(
    'a subscription token turns it off before the installation check: %s',
    async (key) => {
      const app = githubApp([]);
      const check = runner({ status: 'passed' });
      const isolation = createIsolationGate({
        githubApp: () => app,
        checkRunner: () => check,
        organizationKey: () => key,
        now: () => NOW,
      });
      expect(await isolation.run()).toEqual({
        state: 'off',
        reason: ISOLATION_REASONS.subscriptionToken,
        checkedAt: '2026-11-05T10:02:00.000Z',
      });
      expect(app.checkInstallation).not.toHaveBeenCalled();
      expect(check.run).not.toHaveBeenCalled();
      expect(log.mock.calls.map((a) => a.join(' ')).join('\n')).not.toContain(key.trim());
    },
  );

  test.each([['an API key', 'sk-ant-api03-acme-key-0000'], ['no key', undefined]])(
    'with %s the checks run as before',
    async (_name, key) => {
      const app = githubApp([]);
      const check = runner({ status: 'passed' });
      const isolation = createIsolationGate({
        githubApp: () => app,
        checkRunner: () => check,
        organizationKey: () => key,
        now: () => NOW,
      });
      expect((await isolation.run()).state).toBe('on');
      expect(app.checkInstallation).toHaveBeenCalledTimes(1);
    },
  );
});

test('getIsolationGate reads the organization key in organization key mode', async () => {
  const status = await getIsolationGate({ USE_MOCK_DATA: 'true', DEBUG_IT_ANTHROPIC_API_KEY: 'sk-ant-oat01-acme-0000' }).run();
  expect(status).toEqual(expect.objectContaining({ state: 'off', reason: ISOLATION_REASONS.subscriptionToken }));
});
