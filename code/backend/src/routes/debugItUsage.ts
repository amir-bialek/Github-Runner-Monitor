// Debug it usage view for administrators (story 3.13). Answers one row per
// user from the current UTC month's usage objects only (AD-3); logins come
// from the cached GitHub lookup, and a failed lookup shows the ID instead.
// The route reads only; it never writes and logs no object content.
import type express from 'express';
import type { GitHubApp } from '../adapters/githubApp.ts';
import type { RunService, UsageRow, UsageView } from '../services/debugIt/runs.ts';
import type { CheckChain } from './checkChain.ts';

export interface UsageRowView extends UsageRow {
  login: string | null;
}

export interface UsageAnswer extends Omit<UsageView, 'users'> {
  users: UsageRowView[];
}

export interface UsageRouteDeps {
  chain: CheckChain;
  runs: Pick<RunService, 'monthUsage'>;
  githubApp: () => GitHubApp;
}

export function mountUsageRoutes(router: express.Router, deps: UsageRouteDeps): void {
  const { chain, runs } = deps;

  async function lookupLogin(githubUserId: number): Promise<string | null> {
    try {
      return await deps.githubApp().userLogin(githubUserId);
    } catch {
      // A failed lookup shows the ID instead; it never fails the page.
      return null;
    }
  }

  router.get('/usage', ...chain.guard({ access: 'administrator' }), (_req, res, next) => {
    (async () => {
      const outcome = await runs.monthUsage();
      if (!outcome.ok) {
        res.status(outcome.status).json({ error: outcome.error });
        return;
      }
      const users = await Promise.all(
        outcome.view.users.map(async (row) => ({ ...row, login: await lookupLogin(row.githubUserId) })),
      );
      const answer: UsageAnswer = { ...outcome.view, users };
      res.json(answer);
    })().catch((error: unknown) => next(error));
  });
}
