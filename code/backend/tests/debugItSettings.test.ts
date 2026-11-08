import { createMemoryS3Client, createS3Store, S3StoreError, type S3Store } from '../src/adapters/s3Store';
import {
  createSettingsService,
  getSettingsService,
  parseUserIds,
  resetSettingsService,
  SettingsConflictError,
  SettingsUnreadableError,
  type SettingsStore,
} from '../src/services/debugIt/settings';
import { resetS3Store } from '../src/adapters/s3Store';

const log = console.log as jest.Mock;

const HELM = {
  administrators: ['1000001'],
  allowedRepositories: ['acme/payments-api', 'acme/web'],
  allowedUsers: ['1000001', '1000002'],
};

function memoryStore(): S3Store {
  return createS3Store({ bucket: 'acme-bucket', client: createMemoryS3Client() });
}

function audits(): string[] {
  return log.mock.calls.map((a) => a.join(' ')).filter((l) => l.startsWith('[AUDIT]'));
}

beforeEach(() => log.mockClear());

describe('seeding', () => {
  test('creates the record once from the Helm lists, with numeric IDs', async () => {
    const store = memoryStore();
    const create = jest.spyOn(store, 'create');
    const settings = createSettingsService({ store, config: HELM });
    const value = await settings.load();
    expect(value).toEqual({
      allowedRepositories: ['acme/payments-api', 'acme/web'],
      allowedUsers: [{ githubUserId: 1000001 }, { githubUserId: 1000002 }],
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith('settings.json', value);
    expect(audits()).toHaveLength(1);
    expect((await store.read('settings.json'))!.value).toEqual(value);

    await settings.load();
    await settings.load();
    expect(create).toHaveBeenCalledTimes(1);
    expect(audits()).toHaveLength(1);
  });

  test('an invalid Helm repository is not seeded', async () => {
    const settings = createSettingsService({
      store: memoryStore(),
      config: { ...HELM, allowedRepositories: ['payments-api', ' acme/web ', 'acme/web/extra', 'ACME/Web', 'acme/..', ''] },
    });
    expect((await settings.load()).allowedRepositories).toEqual(['acme/web']);
  });

  test('invalid Helm IDs are dropped', async () => {
    expect(parseUserIds(['1000001', 'dana', ' 1000002 ', '-3', '0', '1.5', '1000001', '99999999999999999999'])).toEqual([
      1000001, 1000002,
    ]);
    const settings = createSettingsService({ store: memoryStore(), config: { ...HELM, allowedUsers: ['dana', '1000002'] } });
    expect((await settings.load()).allowedUsers).toEqual([{ githubUserId: 1000002 }]);
  });

  test('a change is never reseeded, even an emptied record after a restart', async () => {
    const store = memoryStore();
    await createSettingsService({ store, config: HELM }).load();
    await store.modify('settings.json', () => ({ allowedRepositories: [], allowedUsers: [] }));
    // A "restart": a new service over the same bucket with the Helm lists set.
    const restarted = createSettingsService({ store, config: HELM });
    expect(await restarted.load()).toEqual({ allowedRepositories: [], allowedUsers: [] });
    expect(await restarted.access(1000002)).toEqual({ allowedUser: false, administrator: false });
  });

  test('changes apply on the next read (no cache)', async () => {
    const store = memoryStore();
    const settings = createSettingsService({ store, config: HELM });
    expect(await settings.access(1000003)).toEqual({ allowedUser: false, administrator: false });
    await store.modify<{ allowedRepositories: string[]; allowedUsers: Array<{ githubUserId: number }> }>(
      'settings.json',
      (current) => ({ ...current!, allowedUsers: [...current!.allowedUsers, { githubUserId: 1000003 }] }),
    );
    expect(await settings.access(1000003)).toEqual({ allowedUser: true, administrator: false });
  });

  test('a lost create race rereads the winner and does not overwrite it', async () => {
    const winner = { allowedRepositories: ['acme/other'], allowedUsers: [{ githubUserId: 1000002 }] };
    let reads = 0;
    const store: SettingsStore = {
      read: (async () => {
        reads += 1;
        return reads === 1 ? null : { value: winner, etag: '"1"' };
      }) as SettingsStore['read'],
      create: jest.fn(async () => {
        throw new S3StoreError('exists', 'exists', 'settings.json');
      }) as SettingsStore['create'],
      modify: jest.fn() as unknown as SettingsStore['modify'],
    };
    const settings = createSettingsService({ store, config: HELM });
    expect(await settings.load()).toEqual(winner);
    expect(audits()).toHaveLength(0);
  });

  test('a failing create is unreadable', async () => {
    const store: SettingsStore = {
      read: (async () => null) as SettingsStore['read'],
      create: (async () => {
        throw new S3StoreError('unreachable', 'down');
      }) as SettingsStore['create'],
      modify: jest.fn() as unknown as SettingsStore['modify'],
    };
    await expect(createSettingsService({ store, config: HELM }).load()).rejects.toBeInstanceOf(SettingsUnreadableError);
  });
});

describe('unreadable settings', () => {
  test('a failing read is unreadable', async () => {
    const store: SettingsStore = {
      read: (async () => {
        throw new S3StoreError('unreachable', 'down');
      }) as SettingsStore['read'],
      create: jest.fn() as unknown as SettingsStore['create'],
      modify: jest.fn() as unknown as SettingsStore['modify'],
    };
    const settings = createSettingsService({ store, config: HELM });
    await expect(settings.load()).rejects.toBeInstanceOf(SettingsUnreadableError);
    await expect(settings.access(1000001)).rejects.toBeInstanceOf(SettingsUnreadableError);
    expect(store.create).not.toHaveBeenCalled();
  });

  test.each([
    ['not an object', [1, 2]],
    ['missing users', { allowedRepositories: [] }],
    ['user ID as a string', { allowedRepositories: [], allowedUsers: [{ githubUserId: '1000001' }] }],
    ['repository not a string', { allowedRepositories: [7], allowedUsers: [] }],
  ])('a malformed record (%s) is unreadable and never overwritten', async (_name, value) => {
    const store = memoryStore();
    await store.create('settings.json', value);
    const create = jest.spyOn(store, 'create');
    await expect(createSettingsService({ store, config: HELM }).load()).rejects.toBeInstanceOf(SettingsUnreadableError);
    expect(create).not.toHaveBeenCalled();
    expect((await store.read('settings.json'))!.value).toEqual(value);
  });
});

describe('matching', () => {
  const current = {
    allowedRepositories: ['Acme/Payments-API'],
    allowedUsers: [{ githubUserId: 1000002 }],
  };

  test('administrators come only from Helm, by numeric ID', () => {
    const settings = createSettingsService({ store: memoryStore(), config: { ...HELM, administrators: ['1000001', 'eli'] } });
    expect(settings.isAdministrator(1000001)).toBe(true);
    expect(settings.isAdministrator(1000002)).toBe(false);
  });

  test('a login never matches; only the user ID decides', async () => {
    // eli renamed to "dana"'s old login: the ID still decides.
    const settings = createSettingsService({ store: memoryStore(), config: { ...HELM, administrators: ['dana', '1000001'] } });
    expect(settings.isAdministrator(1000002)).toBe(false);
    expect(settings.isAllowedUser(current, 1000001)).toBe(false);
    expect(settings.isAllowedUser(current, 1000002)).toBe(true);
  });

  test('an administrator is not an allowed user unless listed', () => {
    const settings = createSettingsService({ store: memoryStore(), config: HELM });
    expect(settings.isAdministrator(1000001)).toBe(true);
    expect(settings.isAllowedUser(current, 1000001)).toBe(false);
  });

  test('repositories match case-insensitively and exactly', () => {
    const settings = createSettingsService({ store: memoryStore(), config: HELM });
    expect(settings.isRepositoryAllowed(current, 'acme/payments-api')).toBe(true);
    expect(settings.isRepositoryAllowed(current, 'acme/payments')).toBe(false);
    expect(settings.isRepositoryAllowed(current, 'other/payments-api')).toBe(false);
    expect(settings.isRepositoryAllowed(current, '')).toBe(false);
  });
});

describe('mock mode', () => {
  afterEach(() => {
    resetSettingsService();
    resetS3Store();
  });

  test('the mock user is administrator and allowed user, and every repository is allowed', async () => {
    const settings = createSettingsService({
      store: memoryStore(),
      config: { administrators: [], allowedRepositories: [], allowedUsers: [] },
      mock: true,
    });
    expect(await settings.access(1000001)).toEqual({ allowedUser: true, administrator: true });
    expect(await settings.access(1000003)).toEqual({ allowedUser: false, administrator: false });
    expect(settings.isRepositoryAllowed(await settings.load(), 'acme/anything')).toBe(true);
  });

  test('getSettingsService works over the in-memory store', async () => {
    const settings = getSettingsService({ USE_MOCK_DATA: 'true' });
    expect(getSettingsService({ USE_MOCK_DATA: 'true' })).toBe(settings);
    expect(await settings.access(1000001)).toEqual({ allowedUser: true, administrator: true });
  });
});

describe('update', () => {
  const addRepo = (name: string) => (current: { allowedRepositories: string[]; allowedUsers: Array<{ githubUserId: number }> }) =>
    current.allowedRepositories.includes(name) ? undefined : { ...current, allowedRepositories: [...current.allowedRepositories, name] };

  test('a missing record is seeded first, then changed', async () => {
    const store = memoryStore();
    const create = jest.spyOn(store, 'create');
    const settings = createSettingsService({ store, config: HELM });
    const result = await settings.update(addRepo('acme/billing'));
    expect(create).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      changed: true,
      settings: {
        allowedRepositories: ['acme/payments-api', 'acme/web', 'acme/billing'],
        allowedUsers: [{ githubUserId: 1000001 }, { githubUserId: 1000002 }],
      },
    });
    expect((await store.read('settings.json'))!.value).toEqual(result.settings);
  });

  test('no change writes nothing', async () => {
    const store = memoryStore();
    const settings = createSettingsService({ store, config: HELM });
    await settings.load();
    const before = (await store.read('settings.json'))!.etag;
    const result = await settings.update(addRepo('acme/web'));
    expect(result.changed).toBe(false);
    expect(result.settings.allowedRepositories).toEqual(['acme/payments-api', 'acme/web']);
    expect((await store.read('settings.json'))!.etag).toBe(before);
  });

  test('exhausted retries are a conflict', async () => {
    const store = memoryStore();
    const settings = createSettingsService({
      store: {
        read: store.read,
        create: store.create,
        modify: async () => {
          throw new S3StoreError('conflict', 'kept changing', 'settings.json');
        },
      },
      config: HELM,
    });
    await expect(settings.update(addRepo('acme/billing'))).rejects.toBeInstanceOf(SettingsConflictError);
  });

  test('other store failures are unreadable', async () => {
    const store = memoryStore();
    const settings = createSettingsService({
      store: {
        read: store.read,
        create: store.create,
        modify: async () => {
          throw new S3StoreError('unreachable', 'down');
        },
      },
      config: HELM,
    });
    await expect(settings.update(addRepo('acme/billing'))).rejects.toBeInstanceOf(SettingsUnreadableError);
  });

  test('a malformed record is unreadable and never written', async () => {
    const store = memoryStore();
    await store.create('settings.json', { allowedRepositories: [7], allowedUsers: [] });
    const modify = jest.spyOn(store, 'modify');
    const change = jest.fn(addRepo('acme/billing'));
    await expect(createSettingsService({ store, config: HELM }).update(change)).rejects.toBeInstanceOf(SettingsUnreadableError);
    expect(change).not.toHaveBeenCalled();
    expect(modify).not.toHaveBeenCalled();
    expect((await store.read('settings.json'))!.value).toEqual({ allowedRepositories: [7], allowedUsers: [] });
  });

  test('a record turned malformed between load and modify is unreadable and never written', async () => {
    const store = memoryStore();
    await createSettingsService({ store, config: HELM }).load();
    // modify sees a record another writer broke after load read it.
    const wrapped: SettingsStore = {
      read: store.read,
      create: store.create,
      modify: (async (_key: string, fn: (current: unknown) => unknown) => fn({ allowedRepositories: 'x' })) as SettingsStore['modify'],
    };
    const change = jest.fn(addRepo('acme/billing'));
    await expect(createSettingsService({ store: wrapped, config: HELM }).update(change)).rejects.toBeInstanceOf(
      SettingsUnreadableError,
    );
    expect(change).not.toHaveBeenCalled();
  });
});
