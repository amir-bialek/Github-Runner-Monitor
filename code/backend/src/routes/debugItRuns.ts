// Debug it run routes (story 3.7). Order on each (AD-11): session and CSRF
// (mounted on the whole router), allowed user, a loader that finds the target
// or run (404 before any permission call), read access to its repositories,
// then the route. Only the feedback route reads a body.
//
// GET /runs (story 3.11) lists the allowed repositories and the signed in
// user's latest run per target, so a Recent history row reopens the same run.
// It passes the allowed user step only: a run is kept when every one of its
// repositories is still allowed and readable by the user; a GitHub error drops
// that run and never fails the answer. Only RunView fields are answered.
//
// GET /runs/:runId/result and PUT /runs/:runId/feedback (story 3.12) pass the
// same chain as GET /runs/:runId. The result answers a RunResultView read
// field by field from the record; the feedback route checks its body, then
// lets only the requester rate a run with a result. Neither the result text
// nor the comment is ever logged.
//
// POST /runs/:runId/pull-requests/:owner/:name (story 4.2) opens a fix pull
// request. Order: allowed user, a loader that finds the run and the download
// named by the two path segments (404 otherwise), a fresh read lookup on every
// repository of the run (AD-11, as for every route that takes a run ID: the
// body quotes the explanation, which may quote any of them), a fresh write
// permission lookup on that download's stored repository name, then the
// service's checks. It reads no body.
//
// The result and feedback answers (story 4.3) fill canOpenPullRequest: the
// download repositories for which the viewer is offered Open a PR. Only the
// requester of a non-fork run with a result is offered a repository whose
// patch part passed validation, is not yet opened, is still allowed and on
// which the (cached) permission lookup answers write. A settings or GitHub
// error leaves repositories out with one error line; it never fails the answer.
import type express from 'express';
import { CHECK_ERRORS, type CheckChain, type DebugItLocals } from './checkChain.ts';
import type { GitHubApp } from '../adapters/githubApp.ts';
import type { DebugItSettings, SettingsService } from '../services/debugIt/settings.ts';
import type { FixPullRequestService } from '../services/debugIt/fixPullRequest.ts';
import {
  parseFeedback,
  RUN_ERRORS,
  runRepositories,
  readDownloads,
  type ResolvedTarget,
  type RunDownload,
  type RunRecord,
  type RunResultView,
  type RunService,
  type RunView,
} from '../services/debugIt/runs.ts';

export interface RunRouteDeps {
  chain: CheckChain;
  runs: RunService;
  settings: Pick<SettingsService, 'load' | 'isRepositoryAllowed'>;
  githubApp: () => GitHubApp;
  fixPullRequests: FixPullRequestService;
}

/** What GET /debug-it/runs answers. */
export interface RunsOverview {
  allowedRepositories: string[];
  runs: RunView[];
}

// Kept off res.locals so nothing else can set or read them.
const loadedTargets = new WeakMap<express.Response, ResolvedTarget>();
const loadedRuns = new WeakMap<express.Response, RunRecord>();
const loadedDownloads = new WeakMap<express.Response, RunDownload>();

export function mountRunRoutes(router: express.Router, deps: RunRouteDeps): void {
  const { chain, runs, settings, githubApp, fixPullRequests } = deps;

  const [listAccess] = chain.guard({ access: 'allowed' });

  // Whether the user may still see this run: every repository allowed and readable.
  async function visible(record: RunRecord, current: DebugItSettings, user: DebugItLocals): Promise<boolean> {
    const repositories = runRepositories(record);
    if (repositories.length === 0 || !repositories.every((r) => settings.isRepositoryAllowed(current, r))) return false;
    for (const repository of repositories) {
      let level: string;
      try {
        level = await githubApp().checkPermission({ githubUserId: user.uid, login: user.login }, repository);
      } catch (error) {
        console.error(
          `[ERROR] Debug it run ${record.runId} left out of the run list: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
        return false;
      }
      if (level !== 'read' && level !== 'write') return false;
    }
    return true;
  }

  const errorText = (error: unknown): string => (error instanceof Error ? error.message : 'unknown error');
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

  // The repositories for which this viewer is offered Open a PR; never throws.
  async function offers(view: RunResultView, record: RunRecord, user: DebugItLocals): Promise<string[]> {
    if (record.requester?.githubUserId !== user.uid) return [];
    if (view.result === null || view.patchCheck === null) return [];
    if (typeof record.headRepository !== 'string' || !same(record.headRepository, record.repository)) return [];
    const candidates = view.patchCheck.repositories.filter(
      (part) =>
        part.status === 'passed' &&
        part.files.length > 0 &&
        !view.fixPullRequests.some((opened) => same(opened.repository, part.repository)),
    );
    if (candidates.length === 0) return [];
    let current: DebugItSettings;
    try {
      current = await settings.load();
    } catch (error) {
      console.error(`[ERROR] Debug it run ${record.runId}: no fix pull request is offered: settings could not be read: ${errorText(error)}`);
      return [];
    }
    const offered: string[] = [];
    for (const part of candidates) {
      if (!settings.isRepositoryAllowed(current, part.repository)) continue;
      let level: string;
      try {
        level = await githubApp().checkPermission({ githubUserId: user.uid, login: user.login }, part.repository);
      } catch (error) {
        console.error(`[ERROR] Debug it run ${record.runId}: no fix pull request is offered for one repository: ${errorText(error)}`);
        continue;
      }
      if (level === 'write') offered.push(part.repository);
    }
    return offered;
  }

  async function resultAnswer(record: RunRecord, user: DebugItLocals): Promise<RunResultView> {
    const view = runs.resultView(record, user.uid);
    return { ...view, canOpenPullRequest: await offers(view, record, user) };
  }

  router.get('/runs', listAccess, (_req, res, next) => {
    const user = res.locals.debugIt as DebugItLocals;
    (async () => {
      let current: DebugItSettings;
      try {
        current = await settings.load();
      } catch (error) {
        console.error(`[ERROR] Debug it settings could not be read: ${error instanceof Error ? error.message : 'unknown error'}`);
        res.status(503).json({ error: CHECK_ERRORS.settingsUnreadable });
        return;
      }
      const listed: RunView[] = [];
      for (const record of runs.latestRunsOf(user.uid)) {
        if (await visible(record, current, user)) listed.push(runs.view(record));
      }
      listed.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
      const body: RunsOverview = { allowedRepositories: [...current.allowedRepositories], runs: listed };
      res.json(body);
    })().catch((error: unknown) => next(error));
  });

  const [startAccess, startRepository] = chain.guard({
    access: 'allowed',
    repositories: {
      permission: 'read',
      resolve: (_req, res) => {
        const target = loadedTargets.get(res);
        return target ? [target.repository] : [];
      },
    },
  });

  const loadTarget: express.RequestHandler = (req, res, next) => {
    const target = runs.findTarget(req.params.kind, req.params.id);
    if (!target) {
      res.status(404).json({ error: RUN_ERRORS.targetNotFound });
      return;
    }
    loadedTargets.set(res, target);
    next();
  };

  router.post('/targets/:kind/:id/runs', startAccess, loadTarget, startRepository, (_req, res, next) => {
    const target = loadedTargets.get(res);
    const user = res.locals.debugIt as DebugItLocals;
    if (!target) {
      res.status(404).json({ error: RUN_ERRORS.targetNotFound });
      return;
    }
    runs.start(target, { githubUserId: user.uid, login: user.login }).then(
      (outcome) => {
        res.status(outcome.status).json(outcome.body);
      },
      (error: unknown) => next(error),
    );
  });

  const [viewAccess, viewRepository] = chain.guard({
    access: 'allowed',
    repositories: {
      permission: 'read',
      resolve: (_req, res) => {
        const record = loadedRuns.get(res);
        return record ? runRepositories(record) : [];
      },
    },
  });

  const loadRun: express.RequestHandler = (req, res, next) => {
    runs.load(req.params.runId).then(
      (outcome) => {
        if (!outcome.ok) {
          res.status(outcome.status).json({ error: outcome.error });
          return;
        }
        loadedRuns.set(res, outcome.record);
        next();
      },
      (error: unknown) => next(error),
    );
  };

  router.get('/runs/:runId', viewAccess, loadRun, viewRepository, (_req, res) => {
    const record = loadedRuns.get(res);
    if (!record) {
      res.status(404).json({ error: RUN_ERRORS.runNotFound });
      return;
    }
    res.json(runs.view(record));
  });

  router.get('/runs/:runId/result', viewAccess, loadRun, viewRepository, (_req, res, next) => {
    const record = loadedRuns.get(res);
    const user = res.locals.debugIt as DebugItLocals;
    if (!record) {
      res.status(404).json({ error: RUN_ERRORS.runNotFound });
      return;
    }
    resultAnswer(record, user).then(
      (body) => {
        res.json(body);
      },
      (error: unknown) => next(error),
    );
  });

  router.put('/runs/:runId/feedback', viewAccess, loadRun, viewRepository, (req, res, next) => {
    const record = loadedRuns.get(res);
    const user = res.locals.debugIt as DebugItLocals;
    if (!record) {
      res.status(404).json({ error: RUN_ERRORS.runNotFound });
      return;
    }
    const parsed = parseFeedback(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    runs.saveFeedback(record.runId, { githubUserId: user.uid }, parsed.input).then(
      (outcome) => {
        if (!outcome.ok) {
          res.status(outcome.status).json({ error: outcome.error });
          return;
        }
        return resultAnswer(outcome.record, user).then((body) => {
          res.json(body);
        });
      },
    ).catch((error: unknown) => next(error));
  });

  const [fixAccess, fixRepository] = chain.guard({
    access: 'allowed',
    repositories: {
      permission: 'write',
      fresh: true,
      // Only the stored repository name of the download, never the URL text.
      resolve: (_req, res) => {
        const download = loadedDownloads.get(res);
        return download ? [download.repository] : [];
      },
    },
  });

  // Open a PR reads fresh too (AD-11): read access to every repository of the run.
  const [, fixReadRepository] = chain.guard({
    access: 'allowed',
    repositories: {
      permission: 'read',
      fresh: true,
      resolve: (_req, res) => {
        const record = loadedRuns.get(res);
        return record ? runRepositories(record) : [];
      },
    },
  });

  const loadRunDownload: express.RequestHandler = (req, res, next) => {
    runs.load(req.params.runId).then(
      (outcome) => {
        if (!outcome.ok) {
          res.status(outcome.status).json({ error: outcome.error });
          return;
        }
        const wanted = `${req.params.owner}/${req.params.name}`.toLowerCase();
        const download = readDownloads(outcome.record.downloads).find((d) => d.repository.toLowerCase() === wanted);
        if (!download) {
          res.status(404).json({ error: RUN_ERRORS.runNotFound });
          return;
        }
        loadedRuns.set(res, outcome.record);
        loadedDownloads.set(res, download);
        next();
      },
      (error: unknown) => next(error),
    );
  };

  router.post('/runs/:runId/pull-requests/:owner/:name', fixAccess, loadRunDownload, fixReadRepository, fixRepository, (_req, res, next) => {
    const record = loadedRuns.get(res);
    const download = loadedDownloads.get(res);
    const user = res.locals.debugIt as DebugItLocals;
    if (!record || !download) {
      res.status(404).json({ error: RUN_ERRORS.runNotFound });
      return;
    }
    fixPullRequests.open(record, download.repository, { githubUserId: user.uid, login: user.login }).then(
      (outcome) => {
        res.status(outcome.status).json(outcome.body);
      },
      (error: unknown) => next(error),
    );
  });
}
