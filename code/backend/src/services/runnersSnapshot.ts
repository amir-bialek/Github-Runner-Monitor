import { GitHubClient } from './githubClient.ts';
import { setCachedData, getCachedData, generateRunnerCacheKey, runnersCache } from './cache.ts';
import { requestBatcher } from '../middleware/requestBatching.ts';
import { transformRunnersCollection } from './dataTransformation.ts';
import { isMockMode, mockRunners } from './mockData.ts';
import type { InternalRunner } from '../types/github.ts';

export async function getRunnersSnapshot(org: string, token: string): Promise<InternalRunner[]> {
  if (isMockMode()) {
    return transformRunnersCollection(mockRunners);
  }

  const cacheKey = generateRunnerCacheKey(org);
  const cached = getCachedData<InternalRunner[]>(runnersCache, cacheKey);
  if (cached) {
    return cached;
  }

  const runners = await requestBatcher.batchRequest(
    `runners:${org}`,
    async () => {
      const client = new GitHubClient(token);
      return client.getRunners(org);
    },
    cacheKey
  );

  const transformed = transformRunnersCollection(runners);
  setCachedData(runnersCache, cacheKey, transformed);
  return transformed;
}
