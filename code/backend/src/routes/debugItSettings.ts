// Debug it settings API for administrators (FR3, FR4, Story 1.7). Lists the
// allowed repositories and allowed users and adds or removes one entry at a
// time. Every change is a delta applied through settings.update, which
// reapplies it to the freshly read record when another save wins the race,
// so no save ever overwrites another one. Only user IDs are stored; logins
// shown in the list come from GitHub, cached 5 minutes per ID.
import type express from 'express';
import { GitHubAppError, type GitHubApp } from '../adapters/githubApp.ts';
import {
  parseRepository,
  SettingsConflictError,
  type DebugItSettings,
  type SettingsChange,
  type SettingsService,
} from '../services/debugIt/settings.ts';
import type { IsolationStatus } from '../services/debugIt/isolation.ts';
import { CHECK_ERRORS, type CheckChain, type DebugItLocals } from './checkChain.ts';

export const SETTINGS_ERRORS = {
  badRepository: 'Enter the repository as owner/name, for example acme/payments-api.',
  badLogin: 'Enter a valid GitHub login.',
  badUserId: 'The user ID must be a positive whole number.',
  unknownUser: 'GitHub knows no user with this login.',
  notMember: 'This user is not a member of the organization this monitor watches.',
  githubFailed: 'GitHub could not look up this user; please try again.',
  conflict: 'The Debug it settings kept changing while your change was being saved; please reload and try again.',
} as const;

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export interface SettingsView {
  allowedRepositories: string[];
  allowedUsers: Array<{ githubUserId: number; login: string | null }>;
  /** The startup isolation check status (story 3.6). */
  isolation: IsolationStatus;
}

export interface SettingsRouteDeps {
  chain: CheckChain;
  settings: SettingsService;
  githubApp: () => GitHubApp;
  isolation: { status(): IsolationStatus };
}

/** The trimmed login, or null when it is not a valid GitHub login. */
export function parseLogin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return LOGIN.test(trimmed) ? trimmed : null;
}

function parseUserId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function bodyField(req: express.Request, name: string): unknown {
  const body = req.body as unknown;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  return (body as Record<string, unknown>)[name];
}

function sameRepository(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

export function mountSettingsRoutes(router: express.Router, deps: SettingsRouteDeps): void {
  const { chain, settings } = deps;
  const guard = () => chain.guard({ access: 'administrator' });

  async function lookupLogin(githubUserId: number): Promise<string | null> {
    try {
      return await deps.githubApp().userLogin(githubUserId);
    } catch {
      // A failed lookup shows the ID instead; it never fails the page.
      return null;
    }
  }

  async function view(current: DebugItSettings): Promise<SettingsView> {
    const allowedUsers = await Promise.all(
      current.allowedUsers.map(async ({ githubUserId }) => ({ githubUserId, login: await lookupLogin(githubUserId) })),
    );
    return { allowedRepositories: [...current.allowedRepositories], allowedUsers, isolation: deps.isolation.status() };
  }

  function failed(res: express.Response, error: unknown): void {
    if (error instanceof SettingsConflictError) {
      res.status(409).json({ error: SETTINGS_ERRORS.conflict });
      return;
    }
    console.error(`[ERROR] Debug it settings could not be read: ${errorText(error)}`);
    res.status(503).json({ error: CHECK_ERRORS.settingsUnreadable });
  }

  // Applies one change, writes one audit line when something was saved, and answers the new view.
  async function apply(res: express.Response, change: SettingsChange, audit: string): Promise<void> {
    let result;
    try {
      result = await settings.update(change);
    } catch (error) {
      failed(res, error);
      return;
    }
    if (result.changed) {
      const admin = res.locals.debugIt as DebugItLocals;
      console.log(`[AUDIT] Debug it settings: administrator ${admin.uid} (${admin.login}) ${audit}`);
    }
    res.json(await view(result.settings));
  }

  function handle(fn: (req: express.Request, res: express.Response) => Promise<void>): express.RequestHandler {
    return (req, res, next) => {
      fn(req, res).catch((error: unknown) => next(error));
    };
  }

  router.get(
    '/settings',
    ...guard(),
    handle(async (_req, res) => {
      let current: DebugItSettings;
      try {
        current = await settings.load();
      } catch (error) {
        failed(res, error);
        return;
      }
      res.json(await view(current));
    }),
  );

  router.post(
    '/settings/repositories',
    ...guard(),
    handle(async (req, res) => {
      const repository = parseRepository(bodyField(req, 'repository'));
      if (!repository) {
        res.status(400).json({ error: SETTINGS_ERRORS.badRepository });
        return;
      }
      await apply(
        res,
        (current) =>
          current.allowedRepositories.some((r) => sameRepository(r, repository))
            ? undefined
            : { ...current, allowedRepositories: [...current.allowedRepositories, repository] },
        `added repository ${repository}`,
      );
    }),
  );

  router.delete(
    '/settings/repositories/:owner/:name',
    ...guard(),
    handle(async (req, res) => {
      const repository = parseRepository(`${req.params.owner}/${req.params.name}`);
      if (!repository) {
        res.status(400).json({ error: SETTINGS_ERRORS.badRepository });
        return;
      }
      await apply(
        res,
        (current) => {
          const kept = current.allowedRepositories.filter((r) => !sameRepository(r, repository));
          return kept.length === current.allowedRepositories.length ? undefined : { ...current, allowedRepositories: kept };
        },
        `removed repository ${repository}`,
      );
    }),
  );

  router.post(
    '/settings/users',
    ...guard(),
    handle(async (req, res) => {
      const login = parseLogin(bodyField(req, 'login'));
      if (!login) {
        res.status(400).json({ error: SETTINGS_ERRORS.badLogin });
        return;
      }
      let user;
      let member: boolean;
      try {
        const app = deps.githubApp();
        user = await app.findUser(login);
        member = user ? await app.checkMembership(user.login) : false;
      } catch (error) {
        console.error(
          `[ERROR] Debug it user lookup failed: ${error instanceof GitHubAppError ? error.message : 'unknown error'}`,
        );
        res.status(502).json({ error: SETTINGS_ERRORS.githubFailed });
        return;
      }
      if (!user) {
        res.status(400).json({ error: SETTINGS_ERRORS.unknownUser });
        return;
      }
      if (!member) {
        res.status(400).json({ error: SETTINGS_ERRORS.notMember });
        return;
      }
      const { githubUserId } = user;
      await apply(
        res,
        (current) =>
          current.allowedUsers.some((u) => u.githubUserId === githubUserId)
            ? undefined
            : { ...current, allowedUsers: [...current.allowedUsers, { githubUserId }] },
        `added user ${githubUserId}`,
      );
    }),
  );

  router.delete(
    '/settings/users/:githubUserId',
    ...guard(),
    handle(async (req, res) => {
      const githubUserId = parseUserId(req.params.githubUserId);
      if (githubUserId === null) {
        res.status(400).json({ error: SETTINGS_ERRORS.badUserId });
        return;
      }
      await apply(
        res,
        (current) => {
          const kept = current.allowedUsers.filter((u) => u.githubUserId !== githubUserId);
          return kept.length === current.allowedUsers.length ? undefined : { ...current, allowedUsers: kept };
        },
        `removed user ${githubUserId}`,
      );
    }),
  );
}
