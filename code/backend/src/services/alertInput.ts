import { buildScaleSets } from './dataTransformation.ts';
import { getQueueAndRunning } from './jobsService.ts';
import { isMockMode } from './mockData.ts';
import { getRunnersSnapshot } from './runnersSnapshot.ts';
import { rememberedGroups, type EvaluationInput } from './alerts.ts';
import type { ScaleSetSummary } from '../types/github.ts';

async function scaleSetsOrNull(): Promise<ScaleSetSummary[] | null> {
  const org = isMockMode() ? 'mock' : process.env.GITHUB_ORGANIZATION;
  const token = isMockMode() ? 'mock-token' : process.env.GITHUB_TOKEN;
  if (!org || !token) return null;
  try {
    return buildScaleSets(await getRunnersSnapshot(org, token));
  } catch (error: any) {
    console.warn(`[WARN] Runner pools could not be read for alerting, so offline alerts are left as they were: ${error?.message ?? error}`);
    return null;
  }
}

export async function gatherAlertInput(): Promise<EvaluationInput> {
  const scaleSets = await scaleSetsOrNull();
  const known = scaleSets ? scaleSets.map(s => s.id) : rememberedGroups();
  const { queue } = await getQueueAndRunning('', '', known);
  return { queue, scaleSets };
}
