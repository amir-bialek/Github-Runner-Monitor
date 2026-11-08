// The one Debug it check chain (AD-11, SR13, SR16), always in this order:
// session, then CSRF on state changing calls, then allowed user or
// administrator, then repository permission, then the route itself.
//
// sessionStep and csrfStep are mounted with router.use on the whole /debug-it
// router, so no route can skip them. Per-route checks come only from guard(),
// which returns [accessStep, repositoryStep] in that fixed order.
import type express from 'express';
import { parseCookies, SESSION_COOKIE, type SessionService } from '../services/session.ts';
import type { DebugItSettings, SettingsService } from '../services/debugIt/settings.ts';
import type { GitHubApp, RepositoryPermission } from '../adapters/githubApp.ts';
import { WEBHOOK_PATH } from './githubWebhook.ts';

export const CHECK_ERRORS = {
  notSignedIn: 'You are not signed in.',
  csrf: 'The request is missing a valid CSRF token.',
  notAllowedUser: 'You are not an allowed Debug it user.',
  notAdministrator: 'Only Debug it administrators can do this.',
  repositoryNotAllowed: 'This repository is not allowed for Debug it.',
  tooLittleAccess: 'You do not have the needed access to this repository.',
  settingsUnreadable: 'Debug it settings could not be read; please try again.',
  githubFailed: 'GitHub could not check your repository access; please try again.',
} as const;

// Every other method counts as a state change and needs a CSRF token.
export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Paths the whole dashboard gate lets through without a session.
const DEBUG_IT_PUBLIC = new Set(['/debug-it/sign-in', '/debug-it/callback', '/debug-it/sign-out']);

/** What sessionStep puts in res.locals.debugIt for later steps and routes. */
export interface DebugItLocals {
  uid: number;
  login: string;
}

export interface RepositoryCheck {
  /** Full names (owner/name) from route params, stored records or GitHub; never the request body. */
  resolve(req: express.Request, res: express.Response): string[] | Promise<string[]>;
  permission: 'read' | 'write';
  /** Skip the 5 minute permission cache (Open a PR). */
  fresh?: boolean;
}

export interface GuardOptions {
  access: 'allowed' | 'administrator';
  repositories?: RepositoryCheck;
}

export interface CheckChain {
  sessionStep: express.RequestHandler;
  csrfStep: express.RequestHandler;
  guard(options: GuardOptions): [express.RequestHandler, express.RequestHandler];
  dashboardGate: express.RequestHandler;
}

export interface CheckChainDeps {
  session: SessionService;
  settings: SettingsService;
  githubApp: GitHubApp | (() => GitHubApp);
}

const RANK: Record<RepositoryPermission, number> = { none: 0, read: 1, write: 2 };

// NaN for anything that is not a known level, so every comparison with it is false.
function rank(level: unknown): number {
  return typeof level === 'string' && Object.prototype.hasOwnProperty.call(RANK, level)
    ? RANK[level as RepositoryPermission]
    : Number.NaN;
}

function refuse(res: express.Response, status: number, error: string): void {
  res.status(status).json({ error });
}

export function createCheckChain(deps: CheckChainDeps): CheckChain {
  const { session, settings } = deps;
  const githubApp = (): GitHubApp => (typeof deps.githubApp === 'function' ? deps.githubApp() : deps.githubApp);
  // Kept off res.locals so routes never see the raw cookie value.
  const cookies = new WeakMap<express.Request, string>();
  // Settings read by accessStep, reused by repositoryStep in the same request.
  const loaded = new WeakMap<express.Request, DebugItSettings>();

  function signedIn(res: express.Response): DebugItLocals | undefined {
    const current = res.locals.debugIt as DebugItLocals | undefined;
    return current && typeof current.uid === 'number' ? current : undefined;
  }

  async function loadSettings(req: express.Request, res: express.Response): Promise<DebugItSettings | undefined> {
    const cached = loaded.get(req);
    if (cached) return cached;
    try {
      const value = await settings.load();
      loaded.set(req, value);
      return value;
    } catch (error) {
      console.error(`[ERROR] Debug it settings could not be read: ${error instanceof Error ? error.message : 'unknown error'}`);
      refuse(res, 503, CHECK_ERRORS.settingsUnreadable);
      return undefined;
    }
  }

  const sessionStep: express.RequestHandler = (req, res, next) => {
    const value = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const current = session.open(value);
    if (!value || !current) {
      refuse(res, 401, CHECK_ERRORS.notSignedIn);
      return;
    }
    cookies.set(req, value);
    res.locals.debugIt = { uid: current.uid, login: current.login } satisfies DebugItLocals;
    next();
  };

  const csrfStep: express.RequestHandler = (req, res, next) => {
    const value = cookies.get(req);
    if (!value || !signedIn(res)) {
      refuse(res, 401, CHECK_ERRORS.notSignedIn);
      return;
    }
    if (!SAFE_METHODS.has(req.method.toUpperCase()) && !session.verifyCsrf(value, req.get('X-CSRF-Token'))) {
      refuse(res, 403, CHECK_ERRORS.csrf);
      return;
    }
    next();
  };

  function guard(options: GuardOptions): [express.RequestHandler, express.RequestHandler] {
    const { access, repositories } = options;
    if (access !== 'allowed' && access !== 'administrator') {
      throw new Error(`Unknown Debug it access level: ${String(access)}`);
    }

    const accessStep: express.RequestHandler = (req, res, next) => {
      const user = signedIn(res);
      if (!user || !cookies.has(req)) {
        refuse(res, 401, CHECK_ERRORS.notSignedIn);
        return;
      }
      if (access === 'administrator') {
        // Administrators come only from Helm values: no settings read needed.
        if (!settings.isAdministrator(user.uid)) {
          refuse(res, 403, CHECK_ERRORS.notAdministrator);
          return;
        }
        next();
        return;
      }
      loadSettings(req, res).then(
        (current) => {
          if (!current) return;
          if (!settings.isAllowedUser(current, user.uid)) {
            refuse(res, 403, CHECK_ERRORS.notAllowedUser);
            return;
          }
          next();
        },
        (error: unknown) => next(error),
      );
    };

    const repositoryStep: express.RequestHandler = (req, res, next) => {
      if (!repositories) {
        next();
        return;
      }
      const user = signedIn(res);
      if (!user) {
        refuse(res, 401, CHECK_ERRORS.notSignedIn);
        return;
      }
      (async () => {
        const names = [...new Set((await repositories.resolve(req, res)).map((n) => String(n).trim()))];
        const current = await loadSettings(req, res);
        if (!current) return;
        // Fail closed: a route that names no repository cannot pass a repository check.
        if (names.length === 0 || names.some((name) => name === '' || !settings.isRepositoryAllowed(current, name))) {
          refuse(res, 403, CHECK_ERRORS.repositoryNotAllowed);
          return;
        }
        const needed = rank(repositories.permission);
        for (const name of names) {
          let level: RepositoryPermission;
          try {
            level = await githubApp().checkPermission({ githubUserId: user.uid, login: user.login }, name, {
              fresh: repositories.fresh === true,
            });
          } catch (error) {
            console.error(
              `[ERROR] Debug it repository permission check failed: ${error instanceof Error ? error.message : 'unknown error'}`,
            );
            refuse(res, 502, CHECK_ERRORS.githubFailed);
            return;
          }
          // Written so an unknown level or needed permission refuses.
          if (!(rank(level) >= needed)) {
            refuse(res, 403, CHECK_ERRORS.tooLittleAccess);
            return;
          }
        }
        next();
      })().catch((error: unknown) => next(error));
    };

    return [accessStep, repositoryStep];
  }

  // Login scope whole-dashboard: every request needs a valid session, except
  // the health check, the GitHub webhook and the sign in routes.
  const dashboardGate: express.RequestHandler = (req, res, next) => {
    const path = req.path;
    if (((req.method === 'GET' || req.method === 'HEAD') && path === '/health') || path === WEBHOOK_PATH || DEBUG_IT_PUBLIC.has(path)) {
      next();
      return;
    }
    const value = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!value || !session.open(value)) {
      refuse(res, 401, CHECK_ERRORS.notSignedIn);
      return;
    }
    next();
  };

  return { sessionStep, csrfStep, guard, dashboardGate };
}
