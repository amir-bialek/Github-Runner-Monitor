// Preview page only (story 3.14): a fixture API for Debug it. Importing this
// module sets axios.defaults.adapter to an in-memory router, so the axios
// instances that services/api.ts creates afterwards answer from invented data
// and never reach a backend. main.tsx imports it before anything else.
//
// Every name, login, repository and token below is invented.
import axios, {
  AxiosError,
  AxiosHeaders,
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import type {
  DebugItRunsOverview,
  DebugItSettingsView,
  DebugItUsageView,
  DebugRunResult,
  DebugRunResultView,
  DebugRunState,
  DebugRunView,
  HistoryTarget,
} from '../types/api';

/** A run that stays in analyzing, shown in the "run in progress" section. */
export const PREVIEW_ANALYZING_RUN_ID = '00000000-0000-4000-8000-0000000000a1';
/** A finished run with a result, on the failed run row of Recent history. */
export const PREVIEW_FINISHED_RUN_ID = '00000000-0000-4000-8000-0000000000f1';
/** How long a run started on the preview page stays in each state. */
export const PREVIEW_STEP_MS = 3000;

export const PREVIEW_SESSION = {
  githubUserId: 1000001,
  login: 'dana',
  csrfToken: 'preview-csrf-not-a-secret',
  allowedUser: true,
  administrator: true,
  loginScope: 'debug-it-only' as const,
};

export const PREVIEW_ALLOWED_REPOSITORIES = ['acme/web-app', 'acme/payments-api', 'acme/infra-tools'];

/** The failed rows of the preview Recent history (fixtures.ts) a run can start on. */
const STARTABLE: Record<string, { repository: string; jobName: string }> = {
  'job:920302': { repository: 'acme/web-app', jobName: 'lint' },
  'run:720306': { repository: 'acme/payments-api', jobName: 'Deploy' },
};

export function previewResult(folder: string): DebugRunResult {
  return {
    explanation:
      'The lint step runs eslint on src/legacy, which this branch deleted, so eslint exits with "No files matching the pattern". ' +
      'Point the lint script at src only.',
    causeLocation: { kind: 'this-repository' },
    patch: [
      `--- a/${folder}/package.json`,
      `+++ b/${folder}/package.json`,
      '@@ -6,5 +6,5 @@',
      '   "scripts": {',
      '     "build": "vite build",',
      '-    "lint": "eslint src src/legacy",',
      '+    "lint": "eslint src",',
      '     "test": "vitest run"',
      '   },',
      '',
    ].join('\n'),
    costUsd: 0.42,
    durationMs: 94000,
    logTruncated: false,
    failureReason: 'none',
  };
}

interface FixtureRun {
  view: Omit<DebugRunView, 'state' | 'elapsedMs' | 'updatedAt'>;
  /** A fixed state, or null to move on with the clock from createdAt. */
  fixedState: DebugRunState | null;
  folder: string;
  feedback: DebugRunResultView['feedback'];
}

export interface FixtureApiOptions {
  now?: () => number;
  stepMs?: number;
}

export interface FixtureApi {
  adapter: AxiosAdapter;
}

const STATE_ORDER: DebugRunState[] = ['waiting', 'cloning', 'analyzing', 'finished'];
const FINAL: ReadonlySet<DebugRunState> = new Set<DebugRunState>(['finished', 'failed']);

export function createFixtureApi(options: FixtureApiOptions = {}): FixtureApi {
  const now = options.now ?? (() => Date.now());
  const stepMs = options.stepMs ?? PREVIEW_STEP_MS;
  const startedAt = now();
  const iso = (ms: number) => new Date(ms).toISOString();

  const runs = new Map<string, FixtureRun>([
    [
      PREVIEW_ANALYZING_RUN_ID,
      {
        view: {
          runId: PREVIEW_ANALYZING_RUN_ID,
          target: { kind: 'job', id: 920399 },
          createdAt: iso(startedAt - 95_000),
          repository: 'acme/infra-tools',
          jobName: 'integration-tests',
          failureReason: null,
        },
        fixedState: 'analyzing',
        folder: 'infra-tools',
        feedback: null,
      },
    ],
    [
      PREVIEW_FINISHED_RUN_ID,
      {
        view: {
          runId: PREVIEW_FINISHED_RUN_ID,
          target: { kind: 'run', id: 720306 },
          createdAt: iso(startedAt - 40 * 60_000),
          repository: 'acme/payments-api',
          jobName: 'Deploy',
          failureReason: null,
        },
        fixedState: 'finished',
        folder: 'payments-api',
        feedback: null,
      },
    ],
  ]);
  let counter = 0;

  const settings: { allowedRepositories: string[]; allowedUsers: DebugItSettingsView['allowedUsers'] } = {
    allowedRepositories: [...PREVIEW_ALLOWED_REPOSITORIES],
    allowedUsers: [
      { githubUserId: 1000001, login: 'dana' },
      { githubUserId: 1000002, login: 'lee' },
    ],
  };
  const KNOWN_USERS: Record<string, number> = { dana: 1000001, lee: 1000002, sam: 1000003 };

  function stateOf(run: FixtureRun): DebugRunState {
    if (run.fixedState) return run.fixedState;
    const steps = Math.floor((now() - Date.parse(run.view.createdAt)) / stepMs);
    return STATE_ORDER[Math.min(Math.max(steps, 0), STATE_ORDER.length - 1)]!;
  }

  function view(run: FixtureRun): DebugRunView {
    const state = stateOf(run);
    const created = Date.parse(run.view.createdAt);
    const end = FINAL.has(state)
      ? run.fixedState
        ? created + 94_000
        : created + (STATE_ORDER.length - 1) * stepMs
      : now();
    return { ...run.view, target: { ...run.view.target }, state, updatedAt: iso(end), elapsedMs: Math.max(0, end - created) };
  }

  function resultView(run: FixtureRun): DebugRunResultView {
    const v = view(run);
    const finished = v.state === 'finished';
    return {
      run: v,
      result: finished ? previewResult(run.folder) : null,
      downloads: finished
        ? [{ repository: v.repository, commitSha: '0123456789abcdef0123456789abcdef01234567', folder: run.folder }]
        : [],
      skippedRepositories: [],
      feedback: run.feedback ? { ...run.feedback } : null,
      canGiveFeedback: finished,
    };
  }

  function settingsView(): DebugItSettingsView {
    return {
      allowedRepositories: [...settings.allowedRepositories],
      allowedUsers: settings.allowedUsers.map((u) => ({ ...u })),
      isolation: { state: 'on', reason: null, checkedAt: iso(startedAt - 10 * 60_000) },
    };
  }

  function usageView(): DebugItUsageView {
    const d = new Date(now());
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    // dana: the two fixture runs (one finished) plus every run started on this page.
    const started = [...runs.values()].filter((r) => !r.fixedState).map(stateOf);
    const mine = started.length + 2;
    const finished = started.filter((s) => s === 'finished').length + 1;
    return {
      month,
      credentialsMode: 'organization',
      monthlyCap: 20,
      users: [
        { githubUserId: 1000002, login: 'lee', runs: 2, costUsd: 0.92, fixPullRequests: 0 },
        { githubUserId: 1000001, login: 'dana', runs: mine, costUsd: Math.round(42 * finished) / 100, fixPullRequests: 0 },
        { githubUserId: 1000003, login: 'sam', runs: 1, costUsd: 0.29, fixPullRequests: 0 },
      ],
    };
  }

  type Answer = { status: number; data: unknown };
  const ok = (data: unknown, status = 200): Answer => ({ status, data });
  const fail = (status: number, error: string): Answer => ({ status, data: { error } });

  function bodyOf(config: InternalAxiosRequestConfig): Record<string, unknown> {
    if (typeof config.data === 'string' && config.data !== '') {
      try {
        const parsed = JSON.parse(config.data) as unknown;
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    }
    return config.data && typeof config.data === 'object' ? (config.data as Record<string, unknown>) : {};
  }

  function start(target: HistoryTarget): Answer {
    const key = `${target.kind}:${target.id}`;
    const startable = STARTABLE[key];
    if (!startable) return fail(404, 'This failed job or run was not found.');
    for (const run of runs.values()) {
      if (`${run.view.target.kind}:${run.view.target.id}` !== key) continue;
      const current = view(run);
      if (!FINAL.has(current.state)) return ok({ ...current, existing: true });
    }
    counter += 1;
    const runId = `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
    const run: FixtureRun = {
      view: {
        runId,
        target: { ...target },
        createdAt: iso(now()),
        repository: startable.repository,
        jobName: startable.jobName,
        failureReason: null,
      },
      fixedState: null,
      folder: startable.repository.split('/')[1] ?? startable.repository,
      feedback: null,
    };
    runs.set(runId, run);
    return ok(view(run), 201);
  }

  // The newest run per target, like the backend's latest-run map.
  function overview(): DebugItRunsOverview {
    const byTarget = new Map<string, DebugRunView>();
    for (const run of runs.values()) {
      const v = view(run);
      const key = `${v.target.kind}:${v.target.id}`;
      const known = byTarget.get(key);
      if (!known || known.createdAt < v.createdAt) byTarget.set(key, v);
    }
    const listed = [...byTarget.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return { allowedRepositories: [...settings.allowedRepositories], runs: listed };
  }

  function route(method: string, path: string, config: InternalAxiosRequestConfig): Answer {
    if (method === 'GET' && path === '/debug-it/session') return ok({ ...PREVIEW_SESSION });
    if (method === 'POST' && path === '/debug-it/sign-out') return ok({});
    if (method === 'GET' && path === '/debug-it/runs') return ok(overview());

    let match = /^\/debug-it\/targets\/(job|run)\/(\d+)\/runs$/.exec(path);
    if (method === 'POST' && match) return start({ kind: match[1] as 'job' | 'run', id: Number(match[2]) });

    match = /^\/debug-it\/runs\/([^/]+)(\/result|\/feedback)?$/.exec(path);
    if (match) {
      const run = runs.get(decodeURIComponent(match[1]!));
      if (!run) return fail(404, 'This debug run was not found.');
      if (method === 'GET' && !match[2]) return ok(view(run));
      if (method === 'GET' && match[2] === '/result') return ok(resultView(run));
      if (method === 'PUT' && match[2] === '/feedback') {
        if (stateOf(run) !== 'finished') return fail(409, 'This debug run has no result to rate yet.');
        const body = bodyOf(config);
        if (body.rating !== 'useful' && body.rating !== 'not-useful') {
          return fail(400, 'Choose Useful or Not useful to rate this result.');
        }
        const comment = typeof body.comment === 'string' && body.comment.trim() !== '' ? body.comment.trim() : null;
        run.feedback = { rating: body.rating, comment, at: iso(now()) };
        return ok(resultView(run));
      }
    }

    if (method === 'GET' && path === '/debug-it/settings') return ok(settingsView());
    if (method === 'GET' && path === '/debug-it/usage') return ok(usageView());
    if (method === 'POST' && path === '/debug-it/settings/repositories') {
      const repository = typeof bodyOf(config).repository === 'string' ? String(bodyOf(config).repository).trim() : '';
      if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository)) return fail(400, 'Enter a repository as owner/name.');
      if (!settings.allowedRepositories.some((r) => r.toLowerCase() === repository.toLowerCase())) {
        settings.allowedRepositories.push(repository);
      }
      return ok(settingsView());
    }
    match = /^\/debug-it\/settings\/repositories\/([^/]+)\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && match) {
      const repository = `${decodeURIComponent(match[1]!)}/${decodeURIComponent(match[2]!)}`.toLowerCase();
      settings.allowedRepositories = settings.allowedRepositories.filter((r) => r.toLowerCase() !== repository);
      return ok(settingsView());
    }
    if (method === 'POST' && path === '/debug-it/settings/users') {
      const login = typeof bodyOf(config).login === 'string' ? String(bodyOf(config).login).trim().toLowerCase() : '';
      const githubUserId = KNOWN_USERS[login];
      if (!githubUserId) return fail(404, 'No GitHub user has this login.');
      if (!settings.allowedUsers.some((u) => u.githubUserId === githubUserId)) {
        settings.allowedUsers.push({ githubUserId, login });
      }
      return ok(settingsView());
    }
    match = /^\/debug-it\/settings\/users\/(\d+)$/.exec(path);
    if (method === 'DELETE' && match) {
      const githubUserId = Number(match[1]);
      settings.allowedUsers = settings.allowedUsers.filter((u) => u.githubUserId !== githubUserId);
      return ok(settingsView());
    }
    return fail(404, 'The preview page has no fixture for this request.');
  }

  function pathOf(config: InternalAxiosRequestConfig): string {
    let url = config.url ?? '';
    const base = (config.baseURL ?? '').replace(/\/+$/, '');
    if (base !== '' && url.startsWith(base)) url = url.slice(base.length);
    url = url.replace(/^https?:\/\/[^/]+/, '');
    const query = url.indexOf('?');
    return query === -1 ? url : url.slice(0, query);
  }

  const adapter: AxiosAdapter = async (config) => {
    const method = (config.method ?? 'get').toUpperCase();
    const answer = route(method, pathOf(config), config);
    const response: AxiosResponse = {
      data: answer.data,
      status: answer.status,
      statusText: String(answer.status),
      headers: new AxiosHeaders({ 'content-type': 'application/json' }),
      config,
      request: null,
    };
    const valid = config.validateStatus ? config.validateStatus(answer.status) : answer.status < 300;
    if (valid) return response;
    throw new AxiosError(
      `Request failed with status code ${answer.status}`,
      answer.status < 500 ? AxiosError.ERR_BAD_REQUEST : AxiosError.ERR_BAD_RESPONSE,
      config,
      null,
      response,
    );
  };

  return { adapter };
}

// Installed on import: every axios instance created after this answers from the fixtures.
axios.defaults.adapter = createFixtureApi().adapter;
