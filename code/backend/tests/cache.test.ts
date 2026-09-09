import { getHealthMetrics } from '../src/services/performanceMonitor';
import {
  getCacheStats,
  setCachedData,
  getCachedData,
  invalidateCache,
  clearAllCache,
  generateRunnerCacheKey,
  runnersCache,
} from '../src/services/cache';
import { toError } from '../src/middleware/requestBatching';

process.env.GITHUB_TOKEN = 'test-token';
process.env.GITHUB_ORGANIZATION = 'test-org';

describe('Cache layer behaviour', () => {
  beforeEach(() => {
    clearAllCache();
  });

  test('a value round-trips unchanged, and an unwritten key reads back undefined', () => {
    const key = generateRunnerCacheKey('test-org');
    const data = { runners: [{ id: 1, name: 'arc-linux-x64-9f2c1' }], total: 1 };

    expect(getCachedData(runnersCache, key)).toBeUndefined();

    setCachedData(runnersCache, key, data);

    expect(getCachedData(runnersCache, key)).toEqual(data);
    expect(getCachedData(runnersCache, generateRunnerCacheKey('other-org'))).toBeUndefined();
  });

  test('cache keys are scoped per organization, so two orgs never read each other\'s data', () => {
    setCachedData(runnersCache, generateRunnerCacheKey('org-a'), 'a-runners');
    setCachedData(runnersCache, generateRunnerCacheKey('org-b'), 'b-runners');

    expect(generateRunnerCacheKey('org-a')).not.toBe(generateRunnerCacheKey('org-b'));
    expect(getCachedData(runnersCache, generateRunnerCacheKey('org-a'))).toBe('a-runners');
    expect(getCachedData(runnersCache, generateRunnerCacheKey('org-b'))).toBe('b-runners');
  });

  test('the cache evicts the least recently used entry once it is full', () => {
    const max = runnersCache.max;

    for (let i = 0; i < max + 2; i++) {
      setCachedData(runnersCache, generateRunnerCacheKey(`org-${i}`), [`runner-${i}`]);
    }

    expect(runnersCache.size).toBe(max);
    expect(getCachedData(runnersCache, generateRunnerCacheKey('org-0'))).toBeUndefined();
    expect(getCachedData(runnersCache, generateRunnerCacheKey('org-1'))).toBeUndefined();
    expect(getCachedData(runnersCache, generateRunnerCacheKey(`org-${max + 1}`))).toEqual([`runner-${max + 1}`]);
  });

  test('invalidating one key leaves the rest of the cache alone', () => {
    setCachedData(runnersCache, generateRunnerCacheKey('org-a'), 'a-runners');
    setCachedData(runnersCache, generateRunnerCacheKey('org-b'), 'b-runners');

    invalidateCache(runnersCache, generateRunnerCacheKey('org-a'));

    expect(getCachedData(runnersCache, generateRunnerCacheKey('org-a'))).toBeUndefined();
    expect(getCachedData(runnersCache, generateRunnerCacheKey('org-b'))).toBe('b-runners');
  });

  test('clearAllCache empties the cache', () => {
    setCachedData(runnersCache, 'k', 1);

    clearAllCache();

    expect(getCacheStats()).toEqual(
      expect.objectContaining({ runners: expect.objectContaining({ size: 0 }) })
    );
  });

  test('getCacheStats reports what is held', () => {
    setCachedData(runnersCache, generateRunnerCacheKey('org-a'), 'a');
    setCachedData(runnersCache, generateRunnerCacheKey('org-b'), 'b');

    expect(getCacheStats().runners.size).toBe(2);
  });
});

describe('Health metrics', () => {
  test('reports the fields /health promises, with usable types', () => {
    const metrics = getHealthMetrics();

    expect(typeof metrics.uptime).toBe('number');
    expect(typeof metrics.totalRequests).toBe('number');
    expect(typeof metrics.errorRate).toBe('number');
    expect(typeof metrics.averageResponseTime).toBe('number');
    expect(Array.isArray(metrics.recentEndpoints)).toBe(true);
    expect(metrics.errorRate).toBeGreaterThanOrEqual(0);
    expect(metrics.errorRate).toBeLessThanOrEqual(100);
  });
});

describe('Turning a thrown value into an Error', () => {
  test('an Error passes straight through', () => {
    const original = new Error('boom');
    expect(toError(original)).toBe(original);
  });

  test('a structured non-Error keeps its message and its fields', () => {
    const thrown = { type: 'AUTHENTICATION', message: 'Invalid GitHub token', statusCode: 401 };

    const error = toError(thrown);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Invalid GitHub token');
    expect(String(error)).not.toContain('[object Object]');
    expect((error as any).statusCode).toBe(401);
  });

  test('anything else still becomes an Error rather than escaping as-is', () => {
    expect(toError('plain string').message).toBe('plain string');
    expect(toError(null).message).toBe('null');
    expect(toError({ nothing: true })).toBeInstanceOf(Error);
  });
});
