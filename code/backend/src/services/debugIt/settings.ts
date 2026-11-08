// Debug it settings (FR3, FR4): the allowed repositories and allowed users,
// kept in one record, debug-it/settings.json, through the s3Store adapter.
// The record is read on every call (no cache), so a change applies on the
// next click. When it is missing it is created once from the Helm lists;
// an existing record is never overwritten, even when an administrator has
// emptied it. Administrators come only from Helm values. Every match is by
// numeric GitHub user ID, never by login (AD-11).
import { getS3Store, S3StoreError, type S3Store } from '../../adapters/s3Store.ts';
import { debugItConfig, type DebugItConfig } from '../debugItConfig.ts';
import { MOCK_REPOSITORIES } from '../mockData.ts';

export const SETTINGS_KEY = 'settings.json';

/** The fixed invented user that mock mode signs in (AD-16). */
export const MOCK_USER_ID = 1000001;

/** The invented allowed users mock mode seeds when the Helm lists are empty (story 3.14). */
export const MOCK_ALLOWED_USER_IDS: readonly number[] = [1000001, 1000002];

export interface DebugItSettings {
  allowedRepositories: string[];
  allowedUsers: Array<{ githubUserId: number }>;
}

export interface UserAccess {
  allowedUser: boolean;
  administrator: boolean;
}

/** The settings record could not be read, or is malformed. */
export class SettingsUnreadableError extends Error {
  constructor(message = 'Debug it settings could not be read.') {
    super(message);
    this.name = 'SettingsUnreadableError';
  }
}

/** The settings kept changing while a change was being saved; the user should reload. */
export class SettingsConflictError extends Error {
  constructor(message = 'Debug it settings kept changing while your change was being saved.') {
    super(message);
    this.name = 'SettingsConflictError';
  }
}

/**
 * One change to the settings: given the current settings, returns the new
 * ones, or undefined when nothing changes. It is reapplied to fresh data when
 * another save wins the race, so it must be a delta, never a whole list.
 */
export type SettingsChange = (current: DebugItSettings) => DebugItSettings | undefined;

export interface SettingsUpdate {
  /** What is stored after the change. */
  settings: DebugItSettings;
  /** Whether anything was written. */
  changed: boolean;
}

export interface SettingsService {
  /** The current settings, seeding them from Helm when missing. Throws SettingsUnreadableError. */
  load(): Promise<DebugItSettings>;
  /** Whether the user ID is a Helm administrator. Needs no read. */
  isAdministrator(githubUserId: number): boolean;
  isAllowedUser(settings: DebugItSettings, githubUserId: number): boolean;
  isRepositoryAllowed(settings: DebugItSettings, repository: string): boolean;
  /** Both flags for one user; reads the settings. Throws SettingsUnreadableError. */
  access(githubUserId: number): Promise<UserAccess>;
  /**
   * Applies one change through a conditional read-modify-write, seeding the
   * record first when missing. Throws SettingsConflictError when the record
   * kept changing, SettingsUnreadableError on any other failure.
   */
  update(change: SettingsChange): Promise<SettingsUpdate>;
}

export type SettingsStore = Pick<S3Store, 'read' | 'create' | 'modify'>;

export interface SettingsServiceOptions {
  store: SettingsStore;
  config: Pick<DebugItConfig, 'administrators' | 'allowedRepositories' | 'allowedUsers'>;
  mock?: boolean;
}

const REPOSITORY_OWNER = /^[A-Za-z0-9-]{1,39}$/;
const REPOSITORY_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** The trimmed owner/name, or null when it is not a valid repository full name. */
export function parseRepository(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const parts = trimmed.split('/');
  if (parts.length !== 2) return null;
  const [owner, name] = parts as [string, string];
  if (!REPOSITORY_OWNER.test(owner) || !REPOSITORY_NAME.test(name) || name === '.' || name === '..') return null;
  return trimmed;
}

/** Parses Helm user IDs into numbers, dropping anything that is not a positive whole number. */
export function parseUserIds(values: readonly string[]): number[] {
  const ids: number[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!/^\d+$/.test(value)) continue;
    const id = Number(value);
    if (Number.isSafeInteger(id) && id > 0 && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function copy(value: DebugItSettings): DebugItSettings {
  return {
    allowedRepositories: [...value.allowedRepositories],
    allowedUsers: value.allowedUsers.map((u) => ({ githubUserId: u.githubUserId })),
  };
}

function isSettings(value: unknown): value is DebugItSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.allowedRepositories) &&
    v.allowedRepositories.every((r) => typeof r === 'string') &&
    Array.isArray(v.allowedUsers) &&
    v.allowedUsers.every(
      (u) =>
        !!u &&
        typeof u === 'object' &&
        typeof (u as { githubUserId?: unknown }).githubUserId === 'number' &&
        Number.isSafeInteger((u as { githubUserId: number }).githubUserId),
    )
  );
}

export function createSettingsService(options: SettingsServiceOptions): SettingsService {
  const { store, config } = options;
  const mock = options.mock === true;
  const administrators = parseUserIds(config.administrators);

  async function readOnce(): Promise<DebugItSettings | null> {
    let record;
    try {
      record = await store.read<unknown>(SETTINGS_KEY);
    } catch {
      throw new SettingsUnreadableError();
    }
    if (record === null) return null;
    if (!isSettings(record.value)) throw new SettingsUnreadableError('The Debug it settings record is malformed.');
    return copy(record.value);
  }

  async function load(): Promise<DebugItSettings> {
    const current = await readOnce();
    if (current) return current;
    const demoSeed = mock && config.allowedRepositories.length === 0 && config.allowedUsers.length === 0;
    const seed: DebugItSettings =
      demoSeed
        ? // Demo mode (story 3.14): invented lists, so Debug it shows on the mock rows.
          {
            allowedRepositories: [...MOCK_REPOSITORIES],
            allowedUsers: MOCK_ALLOWED_USER_IDS.map((githubUserId) => ({ githubUserId })),
          }
        : {
            // Invalid names are dropped: they could never be matched or removed.
            allowedRepositories: config.allowedRepositories
              .map(parseRepository)
              .filter((r): r is string => r !== null)
              .filter((r, i, all) => all.findIndex((o) => o.toLowerCase() === r.toLowerCase()) === i),
            allowedUsers: parseUserIds(config.allowedUsers).map((githubUserId) => ({ githubUserId })),
          };
    try {
      await store.create(SETTINGS_KEY, seed);
    } catch (error) {
      if (error instanceof S3StoreError && error.kind === 'exists') {
        // Another replica created it first: use theirs.
        const theirs = await readOnce();
        if (theirs) return theirs;
      }
      throw new SettingsUnreadableError();
    }
    console.log(
      `[AUDIT] Debug it settings created from the ${demoSeed ? 'invented demo data' : 'Helm values'}: ${seed.allowedRepositories.length} allowed repositories, ${seed.allowedUsers.length} allowed users`,
    );
    return seed;
  }

  function isAdministrator(githubUserId: number): boolean {
    if (mock && githubUserId === MOCK_USER_ID) return true;
    return administrators.includes(githubUserId);
  }

  function isAllowedUser(settings: DebugItSettings, githubUserId: number): boolean {
    if (mock && githubUserId === MOCK_USER_ID) return true;
    return settings.allowedUsers.some((u) => u.githubUserId === githubUserId);
  }

  function isRepositoryAllowed(settings: DebugItSettings, repository: string): boolean {
    if (mock) return true;
    const wanted = repository.trim().toLowerCase();
    if (wanted === '') return false;
    return settings.allowedRepositories.some((r) => r.trim().toLowerCase() === wanted);
  }

  async function access(githubUserId: number): Promise<UserAccess> {
    const settings = await load();
    return { allowedUser: isAllowedUser(settings, githubUserId), administrator: isAdministrator(githubUserId) };
  }

  async function update(change: SettingsChange): Promise<SettingsUpdate> {
    // Seeds the record when missing, and refuses a malformed one before any write.
    await load();
    let changed = false;
    let stored: unknown;
    try {
      stored = await store.modify<unknown>(SETTINGS_KEY, (current) => {
        changed = false;
        if (current === null) throw new SettingsUnreadableError('The Debug it settings record vanished.');
        if (!isSettings(current)) throw new SettingsUnreadableError('The Debug it settings record is malformed.');
        const next = change(copy(current));
        if (next === undefined) return undefined;
        changed = true;
        return copy(next);
      });
    } catch (error) {
      if (error instanceof SettingsUnreadableError) throw error;
      if (error instanceof S3StoreError && error.kind === 'conflict') throw new SettingsConflictError();
      throw new SettingsUnreadableError();
    }
    if (!isSettings(stored)) throw new SettingsUnreadableError('The Debug it settings record is malformed.');
    return { settings: copy(stored), changed };
  }

  return { load, isAdministrator, isAllowedUser, isRepositoryAllowed, access, update };
}

/** A store that resolves the process-wide s3Store on each call, so building it never throws. */
export function lazySettingsStore(env: Record<string, string | undefined> = process.env): SettingsStore {
  return {
    read: (key) => getS3Store(env).read(key),
    create: (key, value) => getS3Store(env).create(key, value),
    modify: (key, fn) => getS3Store(env).modify(key, fn),
  };
}

let singleton: SettingsService | undefined;

/** The settings service for this process, over getS3Store() and debugItConfig. */
export function getSettingsService(env: Record<string, string | undefined> = process.env): SettingsService {
  if (singleton) return singleton;
  singleton = createSettingsService({
    store: lazySettingsStore(env),
    config: debugItConfig,
    mock: env.USE_MOCK_DATA === 'true',
  });
  return singleton;
}

/** Test helper: forget the process-wide settings service. */
export function resetSettingsService(): void {
  singleton = undefined;
}
