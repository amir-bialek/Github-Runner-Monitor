// The one durable store for Debug it records (AD-2). Every record is one JSON
// object under debug-it/ in the existing bucket. Creates send
// If-None-Match: *, updates send If-Match with the ETag just read, and a 412
// or 409 on an update means reread and retry, up to 5 times.
//
// The store talks to S3 through a tiny `{ send }` client that takes plain
// `{ name, input }` commands, so tests inject a fake and never load the SDK.
// With USE_MOCK_DATA=true the same logic runs over an in-memory client that
// keeps ETags, conditional writes and version history (AD-16).

export const RECORD_PREFIX = 'debug-it/';
export const MAX_RETRIES = 5;

export type S3StoreErrorKind = 'conflict' | 'exists' | 'unreachable' | 'failed';

export class S3StoreError extends Error {
  readonly kind: S3StoreErrorKind;
  readonly key: string | undefined;

  constructor(kind: S3StoreErrorKind, message: string, key?: string) {
    super(message);
    this.name = 'S3StoreError';
    this.kind = kind;
    this.key = key;
  }
}

export type S3CommandName =
  | 'GetObjectCommand'
  | 'PutObjectCommand'
  | 'ListObjectVersionsCommand'
  | 'ListObjectsV2Command'
  | 'DeleteObjectCommand'
  | 'HeadBucketCommand';

export interface S3Command {
  name: S3CommandName;
  input: Record<string, unknown>;
}

export interface S3Client {
  send(command: S3Command): Promise<any>;
}

export interface StoredRecord<T> {
  value: T;
  etag: string;
}

export interface S3Store {
  /** The record and its ETag, or null when there is none. */
  read<T>(key: string): Promise<StoredRecord<T> | null>;
  /** Creates the record only if none exists; returns the new ETag. */
  create<T>(key: string, value: T): Promise<string>;
  /**
   * The one read-modify-write door. `fn` gets the current value (or null) and
   * returns the new value, or undefined to write nothing. On a conflicting
   * write it is called again with the fresh value. Returns what is stored.
   */
  modify<T>(key: string, fn: (current: T | null) => T | undefined): Promise<T | null>;
  /** Deletes every version and delete marker of exactly this key. */
  deleteAllVersions(key: string): Promise<number>;
  /** Resolves when the bucket answers; throws an S3StoreError otherwise. */
  checkReachable(): Promise<void>;
  /**
   * The keys (relative to debug-it/, as read() takes them) of every current
   * record whose key starts with `prefix`, sorted, across every page.
   */
  list(prefix: string): Promise<string[]>;
}

export interface S3StoreOptions {
  bucket: string;
  client: S3Client;
}

// ---------------------------------------------------------------------------
// Keys and errors

export function recordKey(key: string): string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new S3StoreError('failed', 'A Debug it record key cannot be empty.');
  }
  if (key.startsWith('/') || key.includes('\\')) {
    throw new S3StoreError('failed', 'A Debug it record key must be a relative path.', key);
  }
  const segments = key.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new S3StoreError('failed', 'A Debug it record key cannot contain empty, "." or ".." parts.', key);
  }
  return RECORD_PREFIX + key;
}

type Outcome = 'missing' | 'precondition' | 'unreachable' | 'failed';

const NETWORK_NAMES = new Set(['TimeoutError', 'NetworkingError', 'RequestTimeout']);
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'EPIPE']);

function classify(error: any): Outcome {
  const status: number | undefined = error?.$metadata?.httpStatusCode;
  const name: string | undefined = error?.name;
  if (name === 'NoSuchBucket') return 'failed';
  if (name === 'NoSuchKey' || name === 'NotFound' || status === 404) return 'missing';
  if (status === 412 || status === 409 || name === 'PreconditionFailed' || name === 'ConditionalRequestConflict') {
    return 'precondition';
  }
  if ((status !== undefined && status >= 500) || NETWORK_NAMES.has(name ?? '') || NETWORK_CODES.has(error?.code)) {
    return 'unreachable';
  }
  return 'failed';
}

function isCreateConflict(error: any): boolean {
  return error?.$metadata?.httpStatusCode === 409 || error?.name === 'ConditionalRequestConflict';
}

function unreachable(key?: string): S3StoreError {
  return new S3StoreError('unreachable', 'S3 cannot be reached, so the Debug it records are not available right now.', key);
}

function toStoreError(error: unknown, action: string, key?: string): S3StoreError {
  if (error instanceof S3StoreError) return error;
  if (classify(error) === 'unreachable') return unreachable(key);
  return new S3StoreError('failed', `S3 refused to ${action}.`, key);
}

async function bodyText(body: unknown): Promise<string> {
  if (typeof body === 'string') return body;
  const reader = body as { transformToString?: () => Promise<string> } | undefined;
  if (reader && typeof reader.transformToString === 'function') return reader.transformToString();
  return '';
}

// ---------------------------------------------------------------------------
// The store, over any `{ send }` client

export function createS3Store(options: S3StoreOptions): S3Store {
  const { bucket, client } = options;

  async function read<T>(key: string): Promise<StoredRecord<T> | null> {
    const fullKey = recordKey(key);
    let response: any;
    try {
      response = await client.send({ name: 'GetObjectCommand', input: { Bucket: bucket, Key: fullKey } });
    } catch (error) {
      if (classify(error) === 'missing') return null;
      throw toStoreError(error, `read the Debug it record ${key}`, key);
    }
    let value: T;
    try {
      value = JSON.parse(await bodyText(response?.Body)) as T;
    } catch {
      throw new S3StoreError('failed', `The Debug it record ${key} is not valid JSON.`, key);
    }
    return { value, etag: String(response?.ETag ?? '') };
  }

  // Returns the new ETag, or null when the condition did not hold.
  async function put<T>(
    key: string,
    value: T,
    condition: { IfMatch: string } | { IfNoneMatch: '*' },
    retryCreate = true,
  ): Promise<string | null> {
    const fullKey = recordKey(key);
    const body = JSON.stringify(value) as string | undefined;
    if (body === undefined) {
      throw new S3StoreError('failed', `The Debug it record ${key} has no value that can be saved as JSON.`, key);
    }
    try {
      const response = await client.send({
        name: 'PutObjectCommand',
        input: {
          Bucket: bucket,
          Key: fullKey,
          Body: body,
          ContentType: 'application/json',
          ...condition,
        },
      });
      return String(response?.ETag ?? '');
    } catch (error) {
      const outcome = classify(error);
      // In a create, a 409 means another write was in progress, not that the record exists.
      if ('IfNoneMatch' in condition && !retryCreate && isCreateConflict(error)) {
        throw new S3StoreError('conflict', `The Debug it record ${key} was being saved by someone else, so try again.`, key);
      }
      // A 404 on If-Match means the record vanished since it was read.
      if (outcome === 'precondition' || (outcome === 'missing' && 'IfMatch' in condition)) return null;
      throw toStoreError(error, `save the Debug it record ${key}`, key);
    }
  }

  async function create<T>(key: string, value: T): Promise<string> {
    recordKey(key);
    const etag = await put(key, value, { IfNoneMatch: '*' }, false);
    if (etag === null) {
      throw new S3StoreError('exists', `The Debug it record ${key} already exists.`, key);
    }
    return etag;
  }

  async function modify<T>(key: string, fn: (current: T | null) => T | undefined): Promise<T | null> {
    recordKey(key);
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const current = await read<T>(key);
      const next = fn(current ? current.value : null);
      if (next === undefined) return current ? current.value : null;
      const written = await put(key, next, current ? { IfMatch: current.etag } : { IfNoneMatch: '*' });
      if (written !== null) return next;
    }
    throw new S3StoreError(
      'conflict',
      `The Debug it record ${key} kept changing while it was being saved, so try again.`,
      key,
    );
  }

  async function deleteAllVersions(key: string): Promise<number> {
    const fullKey = recordKey(key);
    const targets: string[] = [];
    let deleted = 0;
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    try {
      for (;;) {
        const input: Record<string, unknown> = { Bucket: bucket, Prefix: fullKey };
        if (keyMarker !== undefined) input.KeyMarker = keyMarker;
        if (versionIdMarker !== undefined) input.VersionIdMarker = versionIdMarker;
        const page: any = await client.send({ name: 'ListObjectVersionsCommand', input });
        for (const entry of [...(page?.Versions ?? []), ...(page?.DeleteMarkers ?? [])]) {
          if (entry?.Key === fullKey && entry.VersionId) targets.push(String(entry.VersionId));
        }
        if (!page?.IsTruncated) break;
        keyMarker = page.NextKeyMarker;
        versionIdMarker = page.NextVersionIdMarker;
        if (keyMarker === undefined && versionIdMarker === undefined) {
          throw new S3StoreError('failed', `S3 did not say where the next page of versions of ${key} starts.`, key);
        }
      }
      for (const versionId of targets) {
        try {
          await client.send({
            name: 'DeleteObjectCommand',
            input: { Bucket: bucket, Key: fullKey, VersionId: versionId },
          });
          deleted += 1;
        } catch (error) {
          if (classify(error) !== 'missing') throw error;
        }
      }
    } catch (error) {
      throw toStoreError(error, `delete the Debug it record ${key}`, key);
    }
    return deleted;
  }

  async function checkReachable(): Promise<void> {
    try {
      await client.send({ name: 'HeadBucketCommand', input: { Bucket: bucket } });
    } catch (error) {
      throw toStoreError(error, 'open the bucket for Debug it records');
    }
  }

  async function list(prefix: string): Promise<string[]> {
    // A trailing slash names a folder; the parts before it follow the key rules.
    const fullPrefix = recordKey(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix) + (prefix.endsWith('/') ? '/' : '');
    const keys: string[] = [];
    let token: string | undefined;
    try {
      for (;;) {
        const input: Record<string, unknown> = { Bucket: bucket, Prefix: fullPrefix };
        if (token !== undefined) input.ContinuationToken = token;
        const page: any = await client.send({ name: 'ListObjectsV2Command', input });
        for (const entry of page?.Contents ?? []) {
          const key = entry?.Key;
          if (typeof key === 'string' && key.startsWith(fullPrefix)) keys.push(key.slice(RECORD_PREFIX.length));
        }
        if (!page?.IsTruncated) break;
        token = page.NextContinuationToken;
        if (typeof token !== 'string' || token === '') {
          throw new S3StoreError('failed', `S3 did not say where the next page of records under ${prefix} starts.`, prefix);
        }
      }
    } catch (error) {
      throw toStoreError(error, `list the Debug it records under ${prefix}`, prefix);
    }
    return [...new Set(keys)].sort();
  }

  return { read, create, modify, deleteAllVersions, checkReachable, list };
}

// ---------------------------------------------------------------------------
// In-memory client for USE_MOCK_DATA, with S3's conditional semantics

interface MemoryVersion {
  versionId: string;
  etag: string;
  body: string | null; // null is a delete marker
}

function s3Failure(name: string, status: number): Error {
  const error = new Error(name) as Error & { $metadata: { httpStatusCode: number } };
  error.name = name;
  error.$metadata = { httpStatusCode: status };
  return error;
}

export function createMemoryS3Client(options: { pageSize?: number } = {}): S3Client {
  const pageSize = options.pageSize ?? 1000;
  const objects = new Map<string, MemoryVersion[]>(); // oldest first
  let counter = 0;

  const latest = (key: string): MemoryVersion | undefined => {
    const versions = objects.get(key);
    const top = versions?.[versions.length - 1];
    return top && top.body !== null ? top : undefined;
  };

  return {
    async send({ name, input }: S3Command): Promise<any> {
      const key = String(input.Key ?? '');
      switch (name) {
        case 'HeadBucketCommand':
          return {};
        case 'GetObjectCommand': {
          const current = latest(key);
          if (!current) throw s3Failure('NoSuchKey', 404);
          const body = current.body as string;
          return { ETag: current.etag, VersionId: current.versionId, Body: { transformToString: async () => body } };
        }
        case 'PutObjectCommand': {
          const current = latest(key);
          if (input.IfNoneMatch === '*' && current) throw s3Failure('PreconditionFailed', 412);
          if (input.IfMatch !== undefined) {
            if (!current) throw s3Failure('NoSuchKey', 404);
            if (current.etag !== input.IfMatch) throw s3Failure('PreconditionFailed', 412);
          }
          counter += 1;
          const version = { versionId: `v${counter}`, etag: `"mock-${counter}"`, body: String(input.Body ?? '') };
          objects.set(key, [...(objects.get(key) ?? []), version]);
          return { ETag: version.etag, VersionId: version.versionId };
        }
        case 'DeleteObjectCommand': {
          const versions = objects.get(key) ?? [];
          if (input.VersionId === undefined) {
            counter += 1;
            objects.set(key, [...versions, { versionId: `v${counter}`, etag: '', body: null }]);
            return {};
          }
          const remaining = versions.filter((v) => v.versionId !== input.VersionId);
          if (remaining.length) objects.set(key, remaining);
          else objects.delete(key);
          return {};
        }
        case 'ListObjectVersionsCommand': {
          const prefix = String(input.Prefix ?? '');
          const all: Array<{ Key: string; VersionId: string; marker: boolean }> = [];
          for (const k of [...objects.keys()].sort()) {
            if (!k.startsWith(prefix)) continue;
            for (const v of [...(objects.get(k) ?? [])].reverse()) {
              all.push({ Key: k, VersionId: v.versionId, marker: v.body === null });
            }
          }
          let start = 0;
          if (input.KeyMarker !== undefined) {
            const at = all.findIndex((e) => e.Key === input.KeyMarker && e.VersionId === input.VersionIdMarker);
            start = at >= 0 ? at + 1 : all.findIndex((e) => e.Key > String(input.KeyMarker));
            if (start < 0) start = all.length;
          }
          const page = all.slice(start, start + pageSize);
          const truncated = start + pageSize < all.length;
          const last = page[page.length - 1];
          return {
            Versions: page.filter((e) => !e.marker).map(({ Key, VersionId }) => ({ Key, VersionId })),
            DeleteMarkers: page.filter((e) => e.marker).map(({ Key, VersionId }) => ({ Key, VersionId })),
            IsTruncated: truncated,
            ...(truncated && last ? { NextKeyMarker: last.Key, NextVersionIdMarker: last.VersionId } : {}),
          };
        }
        case 'ListObjectsV2Command': {
          const prefix = String(input.Prefix ?? '');
          const current = [...objects.keys()].filter((k) => k.startsWith(prefix) && latest(k)).sort();
          // The continuation token is the last key of the previous page.
          const after = input.ContinuationToken === undefined ? undefined : String(input.ContinuationToken);
          const start = after === undefined ? 0 : current.findIndex((k) => k > after);
          const from = start < 0 ? current.length : start;
          const page = current.slice(from, from + pageSize);
          const truncated = from + pageSize < current.length;
          return {
            Contents: page.map((Key) => ({ Key })),
            KeyCount: page.length,
            IsTruncated: truncated,
            ...(truncated ? { NextContinuationToken: page[page.length - 1] } : {}),
          };
        }
        default:
          throw s3Failure('NotImplemented', 501);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Real SDK client, loaded only when first used

function createAwsClient(region: string): S3Client {
  let loaded: Promise<{ sdkClient: any; sdk: Record<string, any> }> | undefined;
  const load = async () => {
    const sdk: Record<string, any> = await import('@aws-sdk/client-s3');
    return { sdkClient: new sdk.S3Client({ region }), sdk };
  };
  return {
    async send(command: S3Command): Promise<any> {
      if (!loaded) {
        loaded = load();
        loaded.catch(() => {
          loaded = undefined;
        });
      }
      const { sdkClient, sdk } = await loaded;
      const Command = sdk[command.name];
      if (typeof Command !== 'function') {
        throw new S3StoreError('failed', `The S3 command ${command.name} is not known.`);
      }
      return sdkClient.send(new Command(command.input));
    },
  };
}

let singleton: S3Store | undefined;

/** The store for this process, built from the environment on first use. */
export function getS3Store(env: Record<string, string | undefined> = process.env): S3Store {
  if (singleton) return singleton;
  if (env.USE_MOCK_DATA === 'true') {
    singleton = createS3Store({ bucket: 'mock-bucket', client: createMemoryS3Client() });
    return singleton;
  }
  const bucket = env.JOB_STATE_S3_BUCKET;
  if (!bucket) {
    throw new S3StoreError('failed', 'No S3 bucket is set for Debug it records.');
  }
  singleton = createS3Store({ bucket, client: createAwsClient(env.AWS_REGION || 'us-east-2') });
  return singleton;
}

/** Forgets the singleton; for tests. */
export function resetS3Store(): void {
  singleton = undefined;
}
