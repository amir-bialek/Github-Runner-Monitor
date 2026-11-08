// Personal Anthropic keys (story 5.1, Epic 5). In personal key mode each
// allowed user saves, replaces and deletes their own Anthropic API key. The
// key is checked with exactly one Anthropic call (adapters/anthropic.ts),
// then stored AES-256-GCM encrypted at debug-it/personal-keys/{githubUserId}.json
// with a fresh 12-byte nonce for every write and the object key as additional
// authenticated data, so one user's object copied over another's does not
// decrypt. Saving goes through store.modify (create If-None-Match, update
// If-Match, retries); deleting removes every object version and then tells
// the listeners (the run lifecycle cancels the user's waiting runs).
//
// Only the last 4 characters are ever answered, derived by decrypting. No key,
// ciphertext or Anthropic response text is ever logged or answered, and the
// plain key lives only in the call that needs it.
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import {
  AnthropicError,
  getAnthropicAdapter,
  isSubscriptionToken,
  type AnthropicAdapter,
} from '../../adapters/anthropic.ts';
import { getS3Store, recordKey, S3StoreError, type S3Store } from '../../adapters/s3Store.ts';
import { debugItConfig, type CredentialsMode } from '../debugItConfig.ts';
import { parseSessionKey } from '../session.ts';

type Env = Record<string, string | undefined>;

export const PERSONAL_KEY_MIN_LENGTH = 20;
export const PERSONAL_KEY_MAX_LENGTH = 256;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const PRINTABLE = /^[\x20-\x7E]+$/;

export const PERSONAL_KEY_ERRORS = {
  malformed: `Send the personal Anthropic API key as text of ${PERSONAL_KEY_MIN_LENGTH} to ${PERSONAL_KEY_MAX_LENGTH} printable characters.`,
  subscriptionToken:
    'This is a Claude subscription token, which Debug it cannot use; please save an Anthropic API key instead.',
  rejected: 'Anthropic did not accept this API key.',
  unreachable: 'Anthropic could not be reached to check this API key; please try again.',
  organizationMode: 'Personal keys are used only in personal key mode.',
  s3Read: 'S3 cannot be reached, so your personal key cannot be read right now.',
  s3Save: 'S3 cannot be reached, so your personal key cannot be saved right now.',
  s3Delete: 'S3 cannot be reached, so your personal key cannot be deleted right now.',
  unexpected: 'Your personal key request could not be completed; please try again.',
} as const;

/** What is stored at debug-it/personal-keys/{githubUserId}.json; every field but v and savedAt is base64. */
export interface StoredPersonalKey {
  v: 1;
  nonce: string;
  ciphertext: string;
  tag: string;
  savedAt: string;
}

export interface PersonalKeyStatus {
  credentialsMode: CredentialsMode;
  saved: boolean;
  last4: string | null;
}

export type KeyLookup =
  | { status: 'saved'; key: string; /** When it was saved, as stored (ISO 8601), or null when unknown. */ savedAt: string | null }
  | { status: 'none' }
  | { status: 'unreadable' };

export type PersonalKeyOutcome<T> = { ok: true; body: T } | { ok: false; status: 400 | 409 | 502 | 503; error: string };

/** Called after a user's key is deleted; answers how many waiting runs it cancelled. */
export type DeletedListener = (githubUserId: number) => number | Promise<number>;

export interface PersonalKeyService {
  readonly credentialsMode: CredentialsMode;
  /** Whether a key is saved and its last 4 characters. Throws S3StoreError when S3 fails. */
  status(githubUserId: number): Promise<PersonalKeyOutcome<PersonalKeyStatus>>;
  /** Checks the key with one Anthropic call and saves it encrypted, replacing any earlier one. */
  save(githubUserId: number, body: unknown): Promise<PersonalKeyOutcome<PersonalKeyStatus>>;
  /** Deletes every version of the user's key, then cancels their waiting runs. */
  remove(githubUserId: number): Promise<PersonalKeyOutcome<PersonalKeyStatus & { cancelledRuns: number }>>;
  /** The user's decrypted key. Throws S3StoreError when S3 fails. */
  keyFor(githubUserId: number): Promise<KeyLookup>;
  onDeleted(listener: DeletedListener): void;
}

export interface PersonalKeyServiceOptions {
  store: S3Store | (() => S3Store);
  adapter: AnthropicAdapter | (() => AnthropicAdapter);
  /** 32 bytes; required in personal key mode. */
  encryptionKey: Buffer | null;
  credentialsMode: CredentialsMode;
  now?: () => Date;
}

/** The record key (relative to debug-it/) of a user's personal key. */
export function personalKeyKey(githubUserId: number): string {
  if (!Number.isSafeInteger(githubUserId) || githubUserId <= 0) {
    throw new S3StoreError('failed', 'A personal key needs a positive GitHub user ID.');
  }
  return `personal-keys/${githubUserId}.json`;
}

/** Encrypts the key with a fresh nonce; the AAD is the full object key. */
export function encryptPersonalKey(encryptionKey: Buffer, objectKey: string, plain: string, savedAt: string): StoredPersonalKey {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
  cipher.setAAD(Buffer.from(objectKey, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return {
    v: 1,
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    savedAt,
  };
}

/** The plain key, or null when the stored value is malformed, altered, from another key or another object. */
export function decryptPersonalKey(encryptionKey: Buffer, objectKey: string, stored: unknown): string | null {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const value = stored as Partial<Record<keyof StoredPersonalKey, unknown>>;
  if (value.v !== 1 || typeof value.nonce !== 'string' || typeof value.ciphertext !== 'string' || typeof value.tag !== 'string') {
    return null;
  }
  try {
    const nonce = Buffer.from(value.nonce, 'base64');
    const tag = Buffer.from(value.tag, 'base64');
    const ciphertext = Buffer.from(value.ciphertext, 'base64');
    if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES || ciphertext.length === 0) return null;
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, nonce);
    decipher.setAAD(Buffer.from(objectKey, 'utf8'));
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    return plain === '' ? null : plain;
  } catch {
    return null;
  }
}

/** The trimmed key from a { key } body, or null when it is missing or malformed. */
export function parsePersonalKey(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const raw = (body as Record<string, unknown>).key;
  if (typeof raw !== 'string') return null;
  const key = raw.trim();
  if (key.length < PERSONAL_KEY_MIN_LENGTH || key.length > PERSONAL_KEY_MAX_LENGTH || !PRINTABLE.test(key)) return null;
  return key;
}

function last4(key: string): string {
  return key.slice(-4);
}

function errorText(error: unknown): string {
  return error instanceof S3StoreError ? error.message : 'unknown error';
}

export function createPersonalKeyService(options: PersonalKeyServiceOptions): PersonalKeyService {
  const { credentialsMode } = options;
  const personal = credentialsMode === 'personal';
  if (personal && (!options.encryptionKey || options.encryptionKey.length !== 32)) {
    throw new Error('The personal key encryption key must be 32 bytes in personal key mode.');
  }
  const encryptionKey = options.encryptionKey;
  const store = (): S3Store => (typeof options.store === 'function' ? options.store() : options.store);
  const adapter = (): AnthropicAdapter => (typeof options.adapter === 'function' ? options.adapter() : options.adapter);
  const now = options.now ?? (() => new Date());
  const listeners: DeletedListener[] = [];
  // Per-user lock (one backend pod, AD-4): a save and a delete of the same
  // user never interleave, so a save cannot land after a delete listed versions.
  const locks = new Map<number, Promise<unknown>>();

  function withUserLock<T>(githubUserId: number, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(githubUserId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => undefined);
    locks.set(githubUserId, tail);
    void tail.then(() => {
      if (locks.get(githubUserId) === tail) locks.delete(githubUserId);
    });
    return run;
  }

  const none = (): PersonalKeyStatus => ({ credentialsMode, saved: false, last4: null });
  const refuse = (status: 400 | 409 | 502 | 503, error: string) => ({ ok: false as const, status, error });

  async function keyFor(githubUserId: number): Promise<KeyLookup> {
    if (!personal || !encryptionKey) return { status: 'none' };
    const key = personalKeyKey(githubUserId);
    const stored = await store().read<unknown>(key);
    if (!stored) return { status: 'none' };
    const plain = decryptPersonalKey(encryptionKey, recordKey(key), stored.value);
    if (plain === null) {
      console.error(`[ERROR] Debug it personal key of GitHub user ${githubUserId} cannot be read.`);
      return { status: 'unreadable' };
    }
    const savedAt = (stored.value as { savedAt?: unknown }).savedAt;
    return { status: 'saved', key: plain, savedAt: typeof savedAt === 'string' ? savedAt : null };
  }

  return {
    credentialsMode,

    async status(githubUserId) {
      if (!personal) return { ok: true, body: none() };
      let lookup: KeyLookup;
      try {
        lookup = await keyFor(githubUserId);
      } catch (error) {
        console.error(`[ERROR] Debug it personal key of GitHub user ${githubUserId} could not be read: ${errorText(error)}`);
        return refuse(503, PERSONAL_KEY_ERRORS.s3Read);
      }
      if (lookup.status !== 'saved') return { ok: true, body: none() };
      return { ok: true, body: { credentialsMode, saved: true, last4: last4(lookup.key) } };
    },

    save(githubUserId, body) {
      return withUserLock(githubUserId, () => save(githubUserId, body));
    },

    remove(githubUserId) {
      return withUserLock(githubUserId, () => remove(githubUserId));
    },

    keyFor,

    onDeleted(listener) {
      listeners.push(listener);
    },
  };

  async function save(githubUserId: number, body: unknown): Promise<PersonalKeyOutcome<PersonalKeyStatus>> {
    if (!personal || !encryptionKey) return refuse(409, PERSONAL_KEY_ERRORS.organizationMode);
    const key = parsePersonalKey(body);
    if (key === null) return refuse(400, PERSONAL_KEY_ERRORS.malformed);
    if (isSubscriptionToken(key)) {
      console.warn(`[WARN] Debug it personal key of GitHub user ${githubUserId} refused: a subscription token.`);
      return refuse(400, PERSONAL_KEY_ERRORS.subscriptionToken);
    }

    let check: 'valid' | 'rejected';
    try {
      check = await adapter().checkKey(key);
    } catch (error) {
      const detail =
        error instanceof AnthropicError
          ? error.status === null
            ? 'Anthropic could not be reached'
            : `Anthropic answered with status ${error.status}`
          : 'unknown error';
      console.error(`[ERROR] Debug it personal key check failed for GitHub user ${githubUserId}: ${detail}.`);
      return refuse(502, PERSONAL_KEY_ERRORS.unreachable);
    }
    if (check !== 'valid') return refuse(400, PERSONAL_KEY_ERRORS.rejected);

    const recordName = personalKeyKey(githubUserId);
    const objectKey = recordKey(recordName);
    let saved: StoredPersonalKey | null;
    try {
      // A fresh nonce on every attempt, retries included.
      saved = await store().modify<StoredPersonalKey>(recordName, () =>
        encryptPersonalKey(encryptionKey, objectKey, key, now().toISOString()),
      );
    } catch (error) {
      console.error(`[ERROR] Debug it personal key of GitHub user ${githubUserId} could not be saved: ${errorText(error)}`);
      return refuse(503, PERSONAL_KEY_ERRORS.s3Save);
    }
    const plain = decryptPersonalKey(encryptionKey, objectKey, saved);
    console.log(`[AUDIT] Debug it personal key saved by GitHub user ${githubUserId}`);
    return { ok: true, body: { credentialsMode, saved: true, last4: plain === null ? null : last4(plain) } };
  }

  async function remove(githubUserId: number): Promise<PersonalKeyOutcome<PersonalKeyStatus & { cancelledRuns: number }>> {
    if (!personal) return refuse(409, PERSONAL_KEY_ERRORS.organizationMode);
    try {
      await store().deleteAllVersions(personalKeyKey(githubUserId));
    } catch (error) {
      console.error(`[ERROR] Debug it personal key of GitHub user ${githubUserId} could not be deleted: ${errorText(error)}`);
      return refuse(503, PERSONAL_KEY_ERRORS.s3Delete);
    }
    let cancelledRuns = 0;
    for (const listener of listeners) {
      try {
        const count = await listener(githubUserId);
        if (typeof count === 'number' && Number.isFinite(count) && count > 0) cancelledRuns += count;
      } catch {
        console.error(`[ERROR] Debug it personal key of GitHub user ${githubUserId}: a delete listener failed.`);
      }
    }
    console.log(
      `[AUDIT] Debug it personal key deleted by GitHub user ${githubUserId} (${cancelledRuns} waiting runs cancelled)`,
    );
    return { ok: true, body: { ...none(), cancelledRuns } };
  }
}

/**
 * The personal key encryption key from DEBUG_IT_PERSONAL_KEY_ENCRYPTION_KEY.
 * Throws when it is missing or malformed, except in mock mode, where a random
 * key is used.
 */
export function loadPersonalKeyEncryptionKey(env: Env = process.env): Buffer {
  const key = parseSessionKey(env.DEBUG_IT_PERSONAL_KEY_ENCRYPTION_KEY);
  if (key) return key;
  if (env.USE_MOCK_DATA === 'true') return randomBytes(32);
  throw new Error(
    'DEBUG_IT_PERSONAL_KEY_ENCRYPTION_KEY must be 64 hex characters, base64 of 32 bytes or a 32 byte string.',
  );
}

let singleton: PersonalKeyService | undefined;

/**
 * The personal key service of this process. In personal key mode it throws
 * when the encryption key is missing or malformed (outside mock mode); in
 * organization key mode it needs no key and never touches S3.
 */
export function getPersonalKeyService(
  env: Env = process.env,
  credentialsMode: CredentialsMode = debugItConfig.credentialsMode,
): PersonalKeyService {
  if (singleton) return singleton;
  singleton = createPersonalKeyService({
    store: () => getS3Store(env),
    adapter: () => getAnthropicAdapter(env),
    encryptionKey: credentialsMode === 'personal' ? loadPersonalKeyEncryptionKey(env) : null,
    credentialsMode,
  });
  return singleton;
}

/** Test helper: forget the process-wide service. */
export function resetPersonalKeyService(): void {
  singleton = undefined;
}
