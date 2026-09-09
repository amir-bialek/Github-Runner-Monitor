import { LRUCache } from 'lru-cache';

const DEFAULT_RUNNERS_TTL_SECONDS = 30;

function runnersTtlSeconds(): number {
  const raw = process.env.CACHE_TTL_RUNNERS_SECONDS;
  if (raw === undefined || raw === '') return DEFAULT_RUNNERS_TTL_SECONDS;
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `CACHE_TTL_RUNNERS_SECONDS="${raw}" is not a number above zero — using ${DEFAULT_RUNNERS_TTL_SECONDS}`
    );
    return DEFAULT_RUNNERS_TTL_SECONDS;
  }
  return parsed;
}

export const RUNNERS_TTL_SECONDS = runnersTtlSeconds();

const CACHE_CONFIG = {
  RUNNERS_TTL: RUNNERS_TTL_SECONDS * 1000,
  MAX_CACHE_SIZE: parseInt(process.env.CACHE_MAX_SIZE || '100'),
};

export const runnersCache = new LRUCache<string, any>({
  max: CACHE_CONFIG.MAX_CACHE_SIZE,
  ttl: CACHE_CONFIG.RUNNERS_TTL,
});

export const generateRunnerCacheKey = (org: string): string => `runners:${org}`;

export const getCachedData = <T>(cache: LRUCache<string, any>, key: string): T | undefined => {
  const data = cache.get(key);
  return data !== undefined ? (data as T) : undefined;
};

export const setCachedData = <T>(cache: LRUCache<string, any>, key: string, data: T): void => {
  cache.set(key, data);
};

export const invalidateCache = (cache: LRUCache<string, any>, key: string): void => {
  cache.delete(key);
};

export const clearAllCache = (): void => {
  runnersCache.clear();
};

export const getCacheStats = () => {
  return {
    runners: {
      size: runnersCache.size,
      maxSize: runnersCache.max,
      calculatedSize: runnersCache.calculatedSize,
    },
  };
};
