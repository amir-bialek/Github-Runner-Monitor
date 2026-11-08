import express from 'express';
import { randomBytes } from 'crypto';
import type { DebugItConfig } from '../services/debugItConfig.ts';
import {
  createSessionService,
  loadSessionKey,
  parseCookies,
  safeEqual,
  SESSION_COOKIE,
  STATE_COOKIE,
  type SessionService,
} from '../services/session.ts';
import { getGitHubApp, GitHubAppError, type GitHubApp } from '../adapters/githubApp.ts';
import { createSettingsService, lazySettingsStore, type SettingsService } from '../services/debugIt/settings.ts';
import { getIsolationGate, type IsolationStatus } from '../services/debugIt/isolation.ts';
import { CHECK_ERRORS, createCheckChain, type CheckChain } from './checkChain.ts';
import { mountSettingsRoutes } from './debugItSettings.ts';
import { mountRunRoutes } from './debugItRuns.ts';
import { mountUsageRoutes } from './debugItUsage.ts';
import { mountPersonalKeyRoutes, personalKeyErrorHandler } from './debugItPersonalKey.ts';
import { getPersonalKeyService, type PersonalKeyService } from '../services/debugIt/personalKeys.ts';
import { getRunService, type RunService } from '../services/debugIt/runs.ts';
import { getFixPullRequestService, type FixPullRequestService } from '../services/debugIt/fixPullRequest.ts';
import { alertSettingsGate } from './alertSettingsGate.ts';

type Env = Record<string, string | undefined>;

export interface DebugItDeps {
  session?: SessionService;
  githubApp?: GitHubApp;
  settings?: SettingsService;
  /** The startup isolation check status (story 3.6); defaults to the process gate. */
  isolation?: { status(): IsolationStatus };
  /** Debug it runs (story 3.7); defaults to the process run service. */
  runs?: RunService;
  /** Fix pull requests (story 4.2); defaults to the process service. */
  fixPullRequests?: FixPullRequestService;
  /** Personal keys (story 5.1); defaults to the process service. */
  personalKeys?: PersonalKeyService;
  env?: Env;
}

const NOT_A_MEMBER = 'Only members of the organization this monitor watches can sign in.';

// Mounts the Debug it API under /debug-it only when Debug it is enabled.
// When it is off nothing is registered: /debug-it/* falls through to a 404,
// no session check runs on any request and no second port is opened.
// Returns whether the router was mounted. With it on, a missing or malformed
// session key throws here, so the backend fails to start (outside mock mode).
//
// Order with it on: the four sign in routes of Story 1.4 answer first; every
// other /debug-it request then passes the session step and the CSRF step
// (AD-11), so an unknown path is 401 without a session and a state change
// without a valid X-CSRF-Token is 403, both before the 404. Later routes
// mount after those steps and use chain.guard(). Every state changing call
// to the 1.x /settings/alerts routes then needs a session, a valid CSRF token
// and a Debug it administrator (alertSettingsGate). With login scope
// whole-dashboard a gate after the router refuses every other request
// without a session, except /health and the GitHub webhook.
export function registerDebugIt(app: express.Express, config: DebugItConfig, deps: DebugItDeps = {}): boolean {
  if (!config.enabled) return false;
  const env = deps.env ?? process.env;
  const publicUrl = config.publicUrl.replace(/\/+$/, '');
  const session =
    deps.session ?? createSessionService(loadSessionKey(env), { secure: /^https:/i.test(publicUrl) });
  const mock = env.USE_MOCK_DATA === 'true';
  const githubApp = (): GitHubApp => deps.githubApp ?? getGitHubApp(env);
  const settings = deps.settings ?? createSettingsService({ store: lazySettingsStore(env), config, mock });
  const chain = createCheckChain({ session, settings, githubApp });
  const isolation = deps.isolation ?? getIsolationGate(env);
  const runs = deps.runs ?? getRunService(env);
  const fixPullRequests = deps.fixPullRequests ?? getFixPullRequestService(env);
  // In personal key mode a missing or malformed encryption key throws here.
  const personalKeys = deps.personalKeys ?? getPersonalKeyService(env, config.credentialsMode);

  const router = express.Router();
  mountSessionRoutes(router, { config, publicUrl, session, mock, githubApp, settings });
  router.use(chain.sessionStep);
  router.use(chain.csrfStep);
  mountGuardedRoutes(router, { chain, settings, githubApp, isolation, runs, fixPullRequests, personalKeys });
  app.use('/debug-it', router);
  app.use('/debug-it/personal-key', personalKeyErrorHandler);
  // FR45: state changing 1.x alert settings calls need a Debug it administrator.
  app.use('/settings/alerts', alertSettingsGate(chain));
  if (config.loginScope === 'whole-dashboard') {
    app.use(chain.dashboardGate);
  }
  console.log(`[AUDIT] Debug it is enabled (login scope ${config.loginScope})`);
  return true;
}

// Debug it business routes mount here, after the session and CSRF steps,
// each with ...chain.guard({ access, repositories? }).
function mountGuardedRoutes(
  router: express.Router,
  deps: {
    chain: CheckChain;
    settings: SettingsService;
    githubApp: () => GitHubApp;
    isolation: { status(): IsolationStatus };
    runs: RunService;
    fixPullRequests: FixPullRequestService;
    personalKeys: PersonalKeyService;
  },
): void {
  mountSettingsRoutes(router, deps);
  mountRunRoutes(router, deps);
  mountUsageRoutes(router, deps);
  mountPersonalKeyRoutes(router, deps);
}

interface RouteContext {
  config: DebugItConfig;
  publicUrl: string;
  session: SessionService;
  mock: boolean;
  githubApp: () => GitHubApp;
  settings: SettingsService;
}

function startSession(res: express.Response, ctx: RouteContext, uid: number, login: string): void {
  res.append('Set-Cookie', ctx.session.sessionCookie(ctx.session.seal({ uid, login })));
  console.log(`[AUDIT] Debug it sign in: GitHub user ${uid} (${login})`);
  res.redirect(302, `${ctx.publicUrl}/`);
}

function mountSessionRoutes(router: express.Router, ctx: RouteContext): void {
  const { session } = ctx;
  const callbackUrl = `${ctx.publicUrl}/api/debug-it/callback`;

  router.get('/sign-in', (req, res) => {
    if (ctx.mock) {
      // Mock mode: a fixed invented member, no GitHub call (AD-16).
      startSession(res, ctx, 1000001, 'dana');
      return;
    }
    const state = randomBytes(32).toString('hex');
    const params = new URLSearchParams({
      client_id: ctx.config.githubAppClientId,
      redirect_uri: callbackUrl,
      state,
    });
    res.append('Set-Cookie', session.stateCookie(state));
    res.redirect(302, `https://github.com/login/oauth/authorize?${params.toString()}`);
  });

  router.get('/callback', async (req, res) => {
    // The state cookie is single use: cleared whatever the outcome.
    res.append('Set-Cookie', session.clearStateCookie());
    const expected = parseCookies(req.headers.cookie)[STATE_COOKIE];
    const given = req.query.state;
    if (!expected || typeof given !== 'string' || given === '' || !safeEqual(expected, given)) {
      res.status(400).json({ error: 'The sign in request expired or did not start here; please sign in again.' });
      return;
    }
    const code = req.query.code;
    if (req.query.error !== undefined || typeof code !== 'string' || code === '') {
      res.status(400).json({ error: 'GitHub did not complete the sign in.' });
      return;
    }
    let user: { githubUserId: number; login: string };
    let member: boolean;
    try {
      const app = ctx.githubApp();
      user = await app.exchangeCode(code, callbackUrl);
      member = await app.checkMembership(user.login);
    } catch (error) {
      // GitHubAppError messages are built to hold no code or token.
      console.error(`[ERROR] Debug it sign in failed: ${error instanceof GitHubAppError ? error.message : 'unknown error'}`);
      res.status(502).json({ error: 'GitHub could not complete the sign in; please try again.' });
      return;
    }
    if (!member) {
      res.status(403).json({ error: NOT_A_MEMBER });
      return;
    }
    startSession(res, ctx, user.githubUserId, user.login);
  });

  router.get('/session', async (req, res) => {
    const value = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const current = session.open(value);
    if (!value || !current) {
      res.status(401).json({ error: CHECK_ERRORS.notSignedIn, loginScope: ctx.config.loginScope });
      return;
    }
    let access: { allowedUser: boolean; administrator: boolean };
    try {
      access = await ctx.settings.access(current.uid);
    } catch (error) {
      console.error(`[ERROR] Debug it settings could not be read: ${error instanceof Error ? error.message : 'unknown error'}`);
      res.status(503).json({ error: CHECK_ERRORS.settingsUnreadable });
      return;
    }
    res.json({
      githubUserId: current.uid,
      login: current.login,
      csrfToken: session.csrfToken(value),
      allowedUser: access.allowedUser,
      administrator: access.administrator,
      loginScope: ctx.config.loginScope,
      credentialsMode: ctx.config.credentialsMode,
    });
  });

  router.post('/sign-out', (req, res) => {
    const value = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const current = session.open(value);
    if (!value || !current) {
      res.append('Set-Cookie', session.clearSessionCookie());
      res.status(204).end();
      return;
    }
    if (!session.verifyCsrf(value, req.get('X-CSRF-Token'))) {
      res.status(403).json({ error: 'The request is missing a valid CSRF token.' });
      return;
    }
    res.append('Set-Cookie', session.clearSessionCookie());
    console.log(`[AUDIT] Debug it sign out: GitHub user ${current.uid} (${current.login})`);
    res.status(204).end();
  });
}
