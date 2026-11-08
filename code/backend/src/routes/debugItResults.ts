// Debug it results port (story 3.9, AD-8). A separate Express app on its own
// listener (default 3002, reachable only from Debug Job pods per the
// NetworkPolicy) that serves exactly one route: POST /results/{runId}. It
// mounts nothing else: no session, CSRF, settings, run or health routes.
import express from 'express';
import type http from 'http';
import { getS3Store } from '../adapters/s3Store.ts';
import type { DebugItConfig } from '../services/debugItConfig.ts';
import {
  createResultsService,
  RESULT_ERRORS,
  type ResultsService,
  type ResultsServiceDeps,
} from '../services/debugIt/results.ts';
import { createResultValidator, loadResultSchema, ResultSchemaError } from '../services/debugIt/resultSchema.ts';
import type { RunRecord } from '../services/debugIt/runs.ts';
import { getPersonalKeyService } from '../services/debugIt/personalKeys.ts';

type Env = Record<string, string | undefined>;

/** The app of the results port. `maxBodyBytes` is the schema's x-maxBodyBytes. */
export function createResultsApp(service: ResultsService, maxBodyBytes: number): express.Express {
  const app = express();
  app.disable('x-powered-by');

  // Any content type, read raw; one byte over the limit still reaches the
  // validator so it decides the 413.
  const raw = express.raw({ type: () => true, limit: maxBodyBytes + 1 });

  app.post('/results/:runId', raw, (req, res, next) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    service
      .acceptResult(req.params.runId, req.headers.authorization, body)
      .then((outcome) => {
        res.status(outcome.status).json(outcome.body);
      })
      .catch(next);
  });

  app.use((_req, res) => {
    res.status(404).json({ error: RESULT_ERRORS.notFound });
  });

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const err = error as { type?: unknown; status?: unknown; statusCode?: unknown };
    const status = typeof err?.status === 'number' ? err.status : typeof err?.statusCode === 'number' ? err.statusCode : 0;
    if (err?.type === 'entity.too.large' || status === 413) {
      res.status(413).json({ error: RESULT_ERRORS.tooLarge });
      return;
    }
    if (typeof err?.type === 'string' || (status >= 400 && status < 500)) {
      res.status(400).json({ error: RESULT_ERRORS.badRequest });
      return;
    }
    const kind = error instanceof Error ? error.name : typeof error;
    console.error(`[ERROR] Debug it results port: a result post failed unexpectedly (${kind}).`);
    res.status(503).json({ error: RESULT_ERRORS.unavailable });
  });

  return app;
}

export interface ResultsListenerDeps {
  env?: Env;
  /** The schema file to build the validator from; defaults to the shared file. */
  schemaPath?: string;
  store?: ResultsServiceDeps['store'];
  apiKeyFor?: ResultsServiceDeps['apiKeyFor'];
  keyRequired?: boolean;
  now?: () => Date;
  onAccepted?: ResultsServiceDeps['onAccepted'];
  onFailed?: ResultsServiceDeps['onFailed'];
  /** Overrides config.resultsPort (tests pass 0). */
  port?: number;
}

/** Organization key mode: the key the Debug Jobs use. */
export function organizationApiKey(env: Env): string | null {
  const key = env.DEBUG_IT_ANTHROPIC_API_KEY?.trim();
  return key ? key : null;
}

/**
 * Opens the results listener when Debug it is enabled, or returns null.
 * Throws ResultSchemaError when the schema cannot be loaded, so the backend
 * fails to start rather than run with an unchecked results port.
 */
export function openResultsListener(
  config: Pick<DebugItConfig, 'enabled' | 'resultsPort'> & Partial<Pick<DebugItConfig, 'credentialsMode'>>,
  deps: ResultsListenerDeps = {},
): http.Server | null {
  if (!config.enabled) return null;
  const env = deps.env ?? process.env;

  const schema = deps.schemaPath === undefined ? loadResultSchema() : loadResultSchema(deps.schemaPath);
  const validator = createResultValidator(schema);
  // createResultValidator has checked it is a positive integer.
  const maxBodyBytes = (schema as Record<string, unknown>)['x-maxBodyBytes'];
  if (typeof maxBodyBytes !== 'number') {
    throw new ResultSchemaError('Schema must set x-maxBodyBytes to a positive integer.');
  }

  // Personal key mode: the requester's key, read from S3 for each result. A
  // run whose key is gone, or was replaced after the run was created (so the
  // Job may hold the old one), has its result refused (fail closed).
  const personal = config.credentialsMode === 'personal';
  const personalApiKey = async (record: RunRecord): Promise<string | null> => {
    const githubUserId = record.requester?.githubUserId;
    if (typeof githubUserId !== 'number') return null;
    const found = await getPersonalKeyService(env, 'personal').keyFor(githubUserId);
    if (found.status !== 'saved') return null;
    const savedAt = found.savedAt === null ? NaN : Date.parse(found.savedAt);
    const createdAt = Date.parse(record.createdAt);
    if (!Number.isFinite(savedAt) || !Number.isFinite(createdAt) || savedAt > createdAt) return null;
    return found.key;
  };
  const serviceDeps: ResultsServiceDeps = {
    store: deps.store ?? (() => getS3Store(env)),
    validator,
    apiKeyFor: deps.apiKeyFor ?? (personal ? personalApiKey : () => organizationApiKey(env)),
    keyRequired: deps.keyRequired ?? personal,
  };
  if (deps.now) serviceDeps.now = deps.now;
  if (deps.onAccepted) serviceDeps.onAccepted = deps.onAccepted;
  if (deps.onFailed) serviceDeps.onFailed = deps.onFailed;
  const service = createResultsService(serviceDeps);

  const port = deps.port ?? config.resultsPort;
  const server = createResultsApp(service, maxBodyBytes).listen(port, () => {
    const address = server.address();
    const actual = address && typeof address === 'object' ? address.port : port;
    console.log(`[INFO] Debug it results port is listening on port ${actual}`);
  });
  server.on('error', (error: NodeJS.ErrnoException) => {
    console.error(`[ERROR] Debug it results port ${port} could not be opened (${error.code ?? 'unknown error'}).`);
  });
  return server;
}
