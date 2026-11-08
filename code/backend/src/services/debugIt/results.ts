// Debug it results (story 3.9, AD-8). The Debug Job posts one result to
// POST /results/{runId} on the results port with Authorization: Bearer
// {resultCode}. Only the SHA-256 of the result code is on the run record; it
// is compared in constant time and cleared by the same conditional write that
// stores the result, so a result lands once. Five wrong codes end the run
// failed; the count lives on the record, so it survives a restart.
//
// The result is untrusted text: it is checked against the shared schema,
// refused when it holds the run's Anthropic key, and stored as a fresh object
// holding exactly the schema fields. No result code, hash, key or result text
// is ever logged or answered.
//
// The run stays analyzing after acceptance: story 3.10 moves it to finished
// through onAccepted (and deletes the Job through onFailed).
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { S3Store } from '../../adapters/s3Store.ts';
import { S3StoreError } from '../../adapters/s3Store.ts';
import type { DebugResult, ResultValidator } from './resultSchema.ts';
import { isRunId, runKey, type RunRecord } from './runs.ts';

/** Wrong result codes after which the run ends failed. */
export const MAX_WRONG_RESULT_CODES = 5;

export const RESULT_ERRORS = {
  notFound: 'This debug run was not found.',
  unavailable: 'S3 cannot be reached, so the result cannot be stored right now.',
  notAccepting: 'This debug run is not waiting for a result.',
  wrongCode: 'The result code is not valid for this debug run.',
  tooLarge: 'The result is over the size limit.',
  invalid: 'The result does not match the result schema.',
  containsKey: 'The result contains the Anthropic API key, so it was refused.',
  keyUnknown: 'The Anthropic API key of this debug run can no longer be read, so the result was refused.',
  badRequest: 'The request could not be read.',
  tooManyCodes: 'Too many wrong result codes were sent for this debug run.',
} as const;

const SIZE_ERROR_PREFIX = 'result: body is over the size limit';
const HASH = /^[0-9a-f]{64}$/;
const BEARER = /^Bearer ([^\s]+)$/;

/** A new result code: 32 random bytes as base64url (43 characters). */
export function newResultCode(): string {
  return randomBytes(32).toString('base64url');
}

/** The SHA-256 of a result code, as lowercase hex: what the run record holds. */
export function hashResultCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

export type ResultOutcome = {
  status: 200 | 400 | 401 | 404 | 409 | 413 | 422 | 503;
  body: { error: string } | { accepted: true };
};

export type RunHook = (record: RunRecord) => void | Promise<void>;

export interface ResultsServiceDeps {
  store: () => Pick<S3Store, 'read' | 'modify'>;
  validator: ResultValidator;
  /** The Anthropic key the run used, or null when none is known. May throw when it cannot be read. */
  apiKeyFor: (record: RunRecord) => string | null | Promise<string | null>;
  /**
   * Personal key mode: the key must be known to check the result, so a run
   * whose key is gone has its result refused (fail closed).
   */
  keyRequired?: boolean;
  now?: () => Date;
  onAccepted?: RunHook;
  onFailed?: RunHook;
}

export interface ResultsService {
  acceptResult(runId: string, authorization: string | undefined, body: Buffer): Promise<ResultOutcome>;
}

function fail(status: ResultOutcome['status'], error: string): ResultOutcome {
  return { status, body: { error } };
}

function errorText(error: unknown): string {
  return error instanceof S3StoreError ? error.message : 'unknown error';
}

function isRecord(value: unknown, runId: string): value is RunRecord {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as RunRecord).runId === runId &&
    typeof (value as RunRecord).state === 'string'
  );
}

/** The code from `Bearer <code>`, or null when the header is missing or malformed. */
function bearerCode(authorization: string | undefined): string | null {
  if (typeof authorization !== 'string') return null;
  const match = BEARER.exec(authorization);
  return match?.[1] ?? null;
}

function sameHash(storedHex: string, candidateHex: string): boolean {
  const stored = Buffer.from(storedHex, 'hex');
  const candidate = Buffer.from(candidateHex, 'hex');
  if (stored.length !== 32 || candidate.length !== 32) return false;
  return timingSafeEqual(stored, candidate);
}

/** A fresh object holding exactly the ten schema fields. */
function copyResult(result: DebugResult): DebugResult {
  const cause = result.causeLocation;
  return {
    schemaVersion: result.schemaVersion,
    explanation: result.explanation,
    causeLocation:
      cause.kind === 'extra-repository' ? { kind: cause.kind, repository: cause.repository } : { kind: cause.kind },
    patch: result.patch,
    costUsd: result.costUsd,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    durationMs: result.durationMs,
    logTruncated: result.logTruncated,
    failureReason: result.failureReason,
  };
}

function runHook(hook: RunHook | undefined, name: string, record: RunRecord): void {
  if (!hook) return;
  const report = (): void => console.error(`[ERROR] Debug it run ${record.runId}: the ${name} hook failed.`);
  try {
    const outcome = hook(record);
    if (outcome && typeof (outcome as Promise<void>).catch === 'function') (outcome as Promise<void>).catch(report);
  } catch {
    report();
  }
}

export function createResultsService(deps: ResultsServiceDeps): ResultsService {
  const { store, validator, apiKeyFor, onAccepted, onFailed } = deps;
  const now = deps.now ?? (() => new Date());

  async function countWrongCode(runId: string, hash: string): Promise<ResultOutcome> {
    let written: RunRecord | null = null;
    try {
      await store().modify<RunRecord>(runKey(runId), (current) => {
        written = null;
        if (!isRecord(current, runId) || current.state !== 'analyzing' || current.resultCodeHash !== hash) {
          return undefined;
        }
        const count = (typeof current.wrongResultCodes === 'number' ? current.wrongResultCodes : 0) + 1;
        const next: RunRecord = { ...current, wrongResultCodes: count };
        if (count >= MAX_WRONG_RESULT_CODES) {
          next.state = 'failed';
          next.failureReason = RESULT_ERRORS.tooManyCodes;
          next.resultCodeHash = null;
          next.updatedAt = now().toISOString();
        }
        written = next;
        return next;
      });
    } catch (error) {
      console.error(`[ERROR] Debug it run ${runId}: a wrong result code could not be counted: ${errorText(error)}`);
      return fail(503, RESULT_ERRORS.unavailable);
    }
    const record = written as RunRecord | null;
    if (record) {
      if (record.state === 'failed') {
        console.log(
          `[AUDIT] Debug it run ${runId} failed after ${MAX_WRONG_RESULT_CODES} wrong result codes (analyzing -> failed)`,
        );
        runHook(onFailed, 'onFailed', record);
      } else {
        console.warn(
          `[WARN] Debug it run ${runId} received a wrong result code (${record.wrongResultCodes} of ${MAX_WRONG_RESULT_CODES}).`,
        );
      }
    }
    return fail(401, RESULT_ERRORS.wrongCode);
  }

  async function acceptResult(runId: string, authorization: string | undefined, body: Buffer): Promise<ResultOutcome> {
    // 1. The run.
    if (!isRunId(runId)) return fail(404, RESULT_ERRORS.notFound);
    let stored;
    try {
      stored = await store().read<unknown>(runKey(runId));
    } catch (error) {
      console.error(`[ERROR] Debug it run ${runId} could not be read for its result: ${errorText(error)}`);
      return fail(503, RESULT_ERRORS.unavailable);
    }
    if (!stored) return fail(404, RESULT_ERRORS.notFound);
    if (!isRecord(stored.value, runId)) {
      console.error(`[ERROR] Debug it run ${runId} has a malformed record.`);
      return fail(503, RESULT_ERRORS.unavailable);
    }
    const record = stored.value;

    // 2. The run must be waiting for its result.
    const storedHash = record.resultCodeHash;
    if (record.state !== 'analyzing' || typeof storedHash !== 'string' || !HASH.test(storedHash)) {
      return fail(409, RESULT_ERRORS.notAccepting);
    }

    // 3. The result code, in constant time.
    const code = bearerCode(authorization);
    if (code === null || !sameHash(storedHash, hashResultCode(code))) {
      return countWrongCode(runId, storedHash);
    }

    // 4. The schema (size first).
    const outcome = validator(body);
    if (!outcome.ok) {
      if (outcome.errors.some((e) => e.startsWith(SIZE_ERROR_PREFIX))) {
        console.warn(`[WARN] Debug it run ${runId}: the result is over the size limit.`);
        return fail(413, RESULT_ERRORS.tooLarge);
      }
      console.warn(`[WARN] Debug it run ${runId}: the result failed the schema (${outcome.errors.length} errors).`);
      return fail(400, RESULT_ERRORS.invalid);
    }

    // 5. The run's key must not be in the result, raw or escaped.
    // A key that cannot be read (S3 down) throws: the results port answers 503.
    const key = await apiKeyFor(record);
    if (deps.keyRequired && (typeof key !== 'string' || key === '')) {
      console.warn(`[WARN] Debug it run ${runId}: the Anthropic key of the run is not known, so the result was refused.`);
      return fail(422, RESULT_ERRORS.keyUnknown);
    }
    if (typeof key === 'string' && key !== '') {
      if (body.toString('utf8').includes(key) || JSON.stringify(outcome.result).includes(key)) {
        console.warn(`[WARN] Debug it run ${runId}: the result contains the Anthropic API key and was refused.`);
        return fail(422, RESULT_ERRORS.containsKey);
      }
    }

    // 6. Store it once: only while still analyzing with the hash just matched.
    const result = copyResult(outcome.result);
    let accepted: RunRecord | null = null;
    try {
      await store().modify<RunRecord>(runKey(runId), (current) => {
        accepted = null;
        if (!isRecord(current, runId) || current.state !== 'analyzing' || current.resultCodeHash !== storedHash) {
          return undefined;
        }
        accepted = { ...current, result, resultCodeHash: null, updatedAt: now().toISOString() };
        return accepted;
      });
    } catch (error) {
      console.error(`[ERROR] Debug it run ${runId}: the result could not be stored: ${errorText(error)}`);
      return fail(503, RESULT_ERRORS.unavailable);
    }
    const updated = accepted as RunRecord | null;
    if (!updated) return fail(409, RESULT_ERRORS.notAccepting);

    console.log(`[AUDIT] Debug it run ${runId} result accepted`);
    runHook(onAccepted, 'onAccepted', updated);
    return { status: 200, body: { accepted: true } };
  }

  return { acceptResult };
}
