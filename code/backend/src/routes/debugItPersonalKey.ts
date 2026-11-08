// Debug it personal key API (story 5.1). Every allowed user reads, saves
// (or replaces) and deletes their own Anthropic API key. Answers carry only
// the last 4 characters; errors are one sentence. PUT and DELETE pass the
// CSRF step mounted on the router before these routes. The key, ciphertext
// and any Anthropic answer are never logged or answered.
import type express from 'express';
import {
  PERSONAL_KEY_ERRORS,
  type PersonalKeyOutcome,
  type PersonalKeyService,
} from '../services/debugIt/personalKeys.ts';
import type { CheckChain, DebugItLocals } from './checkChain.ts';

export interface PersonalKeyRouteDeps {
  chain: CheckChain;
  personalKeys: PersonalKeyService;
}

export function mountPersonalKeyRoutes(router: express.Router, deps: PersonalKeyRouteDeps): void {
  const { chain, personalKeys } = deps;
  const guard = () => chain.guard({ access: 'allowed' });

  function answer<T>(res: express.Response, outcome: PersonalKeyOutcome<T>): void {
    if (outcome.ok) res.json(outcome.body);
    else res.status(outcome.status).json({ error: outcome.error });
  }

  const user = (res: express.Response): number => (res.locals.debugIt as DebugItLocals).uid;

  router.get('/personal-key', ...guard(), (_req, res, next) => {
    personalKeys
      .status(user(res))
      .then((outcome) => answer(res, outcome))
      .catch(next);
  });

  router.put('/personal-key', ...guard(), (req, res, next) => {
    personalKeys
      .save(user(res), req.body as unknown)
      .then((outcome) => answer(res, outcome))
      .catch(next);
  });

  router.delete('/personal-key', ...guard(), (_req, res, next) => {
    personalKeys
      .remove(user(res))
      .then((outcome) => answer(res, outcome))
      .catch(next);
  });
}

/**
 * Mounted on the app at /debug-it/personal-key after the router: a body the
 * JSON parser refused (whose error text may quote the key) or any other
 * error answers one sentence, and no error text is logged.
 */
export const personalKeyErrorHandler: express.ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const err = error as { type?: unknown; status?: unknown; statusCode?: unknown };
  const status = typeof err?.status === 'number' ? err.status : typeof err?.statusCode === 'number' ? err.statusCode : 0;
  if (typeof err?.type === 'string' || (status >= 400 && status < 500)) {
    res.status(400).json({ error: PERSONAL_KEY_ERRORS.malformed });
    return;
  }
  const kind = error instanceof Error ? error.name : typeof error;
  console.error(`[ERROR] Debug it personal key request failed unexpectedly (${kind}).`);
  res.status(503).json({ error: PERSONAL_KEY_ERRORS.unexpected });
};
