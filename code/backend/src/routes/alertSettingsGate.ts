// FR45: with Debug it enabled, only a Debug it administrator may change the
// 1.x alert settings. Mounted by registerDebugIt as
// app.use('/settings/alerts', alertSettingsGate(chain)), so it shares Express's
// path matching with the 1.x routes (case-insensitive, optional trailing
// slash) and covers every sub path such as /test.
//
// Reads (GET, HEAD, OPTIONS) leave the gate untouched. Every other method runs
// the check chain in its fixed order (session, CSRF, administrator) before the
// 1.x handler, which keeps its own ALERT_SETTINGS_EDITABLE lock.
import express from 'express';
import { SAFE_METHODS, type CheckChain } from './checkChain.ts';

export function alertSettingsGate(chain: CheckChain): express.Router {
  const router = express.Router();
  router.use((req, res, next) => {
    if (SAFE_METHODS.has(req.method.toUpperCase())) {
      next('router');
      return;
    }
    next();
  });
  router.use(chain.sessionStep, chain.csrfStep, ...chain.guard({ access: 'administrator' }));
  return router;
}
