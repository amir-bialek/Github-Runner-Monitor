// Story 3.14: the preview page's Debug it fixture API. Importing it first
// makes the axios instances of services/api.ts answer from invented data.
import axios from 'axios';
import {
  createFixtureApi,
  PREVIEW_ALLOWED_REPOSITORIES,
  PREVIEW_ANALYZING_RUN_ID,
  PREVIEW_FINISHED_RUN_ID,
} from './fixtureApi';
import {
  addAllowedRepository,
  fetchDebugItRuns,
  fetchDebugItSettings,
  fetchDebugItUsage,
  fetchDebugRun,
  fetchDebugRunResult,
  fetchSession,
  saveDebugRunFeedback,
  startDebugRun,
} from '../services/api';
import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios';

const REAL_NAMES = /anthropic|sk-ant|ghp_|github_pat_/i;

function call(adapter: AxiosAdapter, method: string, url: string, data?: unknown) {
  return adapter({
    method,
    url,
    baseURL: '/api',
    data: data === undefined ? undefined : JSON.stringify(data),
    headers: {},
  } as unknown as InternalAxiosRequestConfig);
}

describe('preview fixture API', () => {
  test('importing it installs the adapter for every axios instance', () => {
    expect(typeof axios.defaults.adapter).toBe('function');
  });

  test('the session is signed in, allowed, administrator, debug-it-only', async () => {
    const session = await fetchSession();
    expect(session).toEqual({
      state: 'signed-in',
      githubUserId: 1000001,
      login: 'dana',
      csrfToken: expect.any(String),
      allowedUser: true,
      administrator: true,
      loginScope: 'debug-it-only',
      credentialsMode: 'organization',
    });
  });

  test('runs, run, result, settings and usage answer with invented data', async () => {
    const overview = await fetchDebugItRuns();
    expect(overview.allowedRepositories).toEqual(PREVIEW_ALLOWED_REPOSITORIES);
    expect(overview.runs.map((r) => r.runId)).toEqual(
      expect.arrayContaining([PREVIEW_ANALYZING_RUN_ID, PREVIEW_FINISHED_RUN_ID]),
    );

    expect((await fetchDebugRun(PREVIEW_ANALYZING_RUN_ID)).state).toBe('analyzing');
    const finished = await fetchDebugRunResult(PREVIEW_FINISHED_RUN_ID);
    expect(finished.run.state).toBe('finished');
    expect(finished.result?.patch).toContain('a/payments-api/');
    expect(finished.canGiveFeedback).toBe(true);
    expect((await fetchDebugRunResult(PREVIEW_ANALYZING_RUN_ID)).result).toBeNull();

    const rated = await saveDebugRunFeedback(PREVIEW_FINISHED_RUN_ID, { rating: 'useful', comment: 'Nice' });
    expect(rated.feedback).toMatchObject({ rating: 'useful', comment: 'Nice' });

    const settings = await fetchDebugItSettings();
    expect(settings.allowedUsers.map((u) => u.login)).toEqual(['dana', 'lee']);
    expect(settings.isolation?.state).toBe('on');
    expect((await addAllowedRepository('acme/billing-service')).allowedRepositories).toContain('acme/billing-service');

    const usage = await fetchDebugItUsage();
    expect(usage.users.map((u) => u.login)).toEqual(['lee', 'dana', 'sam']);

    const everything = JSON.stringify([overview, finished, settings, usage]);
    expect(everything).not.toMatch(REAL_NAMES);
  });

  test('an unknown run or target is 404 with one sentence', async () => {
    // The api module logs every failed request.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(fetchDebugRun('00000000-0000-4000-8000-00000000ffff')).rejects.toThrow('This debug run was not found.');
    await expect(startDebugRun({ kind: 'job', id: 1 })).rejects.toThrow('This failed job or run was not found.');
    quiet.mockRestore();
  });

  test('a started run moves from waiting to finished, and a second click answers it', async () => {
    let now = Date.UTC(2026, 10, 6, 10, 0, 0);
    const { adapter } = createFixtureApi({ now: () => now, stepMs: 1000 });

    const started = await call(adapter, 'post', '/debug-it/targets/job/920302/runs');
    expect(started.status).toBe(201);
    expect(started.data).toMatchObject({ state: 'waiting', repository: 'acme/web-app', jobName: 'lint' });
    const runId = (started.data as { runId: string }).runId;

    const again = await call(adapter, 'post', '/debug-it/targets/job/920302/runs');
    expect(again.status).toBe(200);
    expect(again.data).toMatchObject({ runId, existing: true });

    const seen: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      seen.push(((await call(adapter, 'get', `/debug-it/runs/${runId}`)).data as { state: string }).state);
      now += 1000;
    }
    expect(seen).toEqual(['waiting', 'cloning', 'analyzing', 'finished']);

    const result = await call(adapter, 'get', `/debug-it/runs/${runId}/result`);
    expect((result.data as { result: { patch: string } }).result.patch).toContain('a/web-app/package.json');

    const after = await call(adapter, 'post', '/debug-it/targets/job/920302/runs');
    expect(after.status).toBe(201);
  });
});
