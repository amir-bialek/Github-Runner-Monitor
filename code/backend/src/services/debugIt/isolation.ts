// Debug it startup isolation check (story 3.6, SR8, FR31, AD-7). Run once at
// startup when Debug it is enabled: first the Debug it GitHub App installation
// must hold none of the forbidden permissions, then a short check Job with the
// Debug Job labels must prove the network rules isolate it and still let it
// reach the Anthropic API. The status lives in memory only; a restart runs the
// check again. Until the status is `on`, story 3.7 refuses every run; the
// settings page shows the one-sentence reason.
//
// Before both, in organization key mode, the organization key must not be a
// Claude subscription token (story 5.1).
//
// Reasons are fixed sentences: never a token, key, response body or error text.
import { getGitHubApp, type GitHubApp } from '../../adapters/githubApp.ts';
import {
  getIsolationCheckRunner,
  type CheckOutcome,
  type IsolationCheckRunner,
} from '../../adapters/kubernetes.ts';
import { isSubscriptionToken } from '../../adapters/anthropic.ts';
import { debugItConfig } from '../debugItConfig.ts';

export type IsolationState = 'checking' | 'on' | 'off';

export interface IsolationStatus {
  state: IsolationState;
  /** One sentence; null when on. */
  reason: string | null;
  /** ISO 8601 UTC, set when the check ends (passed or failed). */
  checkedAt: string | null;
}

/** "a", "a and b", "a, b and c". */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export const ISOLATION_REASONS = {
  checking: 'Debug it is off until the startup isolation check finishes.',
  subscriptionToken:
    'Debug it is off because the organization Anthropic API key is a Claude subscription token, which Debug it must not use.',
  forbidden: (names: readonly string[]): string =>
    `Debug it is off because the Debug it GitHub App has the ${joinNames(names)} ${
      names.length > 1 ? 'permissions' : 'permission'
    }, which it must not have.`,
  installationUnreadable: 'Debug it is off because the Debug it GitHub App installation could not be read.',
  notStarted: 'Debug it is off because the isolation check Job could not be started.',
  forbiddenReached: 'Debug it is off because the isolation check Job reached an address the network rules must block.',
  anthropicUnreached: 'Debug it is off because the isolation check Job could not reach the Anthropic API.',
  both: 'Debug it is off because the isolation check Job reached a blocked address and could not reach the Anthropic API.',
  failed: 'Debug it is off because the isolation check Job failed.',
  timeout: 'Debug it is off because the isolation check Job did not finish within 2 minutes.',
} as const;

export interface IsolationGateOptions {
  githubApp: () => GitHubApp;
  checkRunner: () => IsolationCheckRunner;
  /** Organization key mode: the organization Anthropic key, checked first. */
  organizationKey?: () => string | null | undefined;
  now?: () => Date;
}

export interface IsolationGate {
  /** The current status; `checking` until run() ends. */
  status(): IsolationStatus;
  /** Runs the check once; later calls return the same promise. Never rejects. */
  run(): Promise<IsolationStatus>;
}

function outcomeReason(outcome: CheckOutcome): string | null {
  switch (outcome.status) {
    case 'passed':
      return null;
    case 'timeout':
      return ISOLATION_REASONS.timeout;
    case 'not-started':
      return ISOLATION_REASONS.notStarted;
    case 'failed':
      if (outcome.exitCode === 3) return ISOLATION_REASONS.forbiddenReached;
      if (outcome.exitCode === 4) return ISOLATION_REASONS.anthropicUnreached;
      if (outcome.exitCode === 5) return ISOLATION_REASONS.both;
      return ISOLATION_REASONS.failed;
    default:
      return ISOLATION_REASONS.failed;
  }
}

export function createIsolationGate(options: IsolationGateOptions): IsolationGate {
  const now = options.now ?? (() => new Date());
  let current: IsolationStatus = { state: 'checking', reason: ISOLATION_REASONS.checking, checkedAt: null };
  let running: Promise<IsolationStatus> | undefined;

  // The reason the check ended with, or null when it passed.
  async function check(): Promise<string | null> {
    if (options.organizationKey && isSubscriptionToken(options.organizationKey())) {
      return ISOLATION_REASONS.subscriptionToken;
    }
    let forbidden: string[];
    try {
      forbidden = [...(await options.githubApp().checkInstallation()).forbidden];
    } catch {
      return ISOLATION_REASONS.installationUnreadable;
    }
    if (forbidden.length > 0) return ISOLATION_REASONS.forbidden(forbidden);
    let runner: IsolationCheckRunner;
    try {
      runner = options.checkRunner();
    } catch {
      return ISOLATION_REASONS.notStarted;
    }
    let outcome: CheckOutcome;
    try {
      outcome = await runner.run();
    } catch {
      return ISOLATION_REASONS.failed;
    }
    return outcomeReason(outcome);
  }

  async function execute(): Promise<IsolationStatus> {
    let reason: string | null;
    try {
      reason = await check();
    } catch {
      reason = ISOLATION_REASONS.failed;
    }
    let checkedAt: string | null;
    try {
      checkedAt = now().toISOString();
    } catch {
      checkedAt = null;
    }
    current = reason === null ? { state: 'on', reason: null, checkedAt } : { state: 'off', reason, checkedAt };
    console.log(
      current.state === 'on'
        ? '[AUDIT] Debug it isolation check: on'
        : `[AUDIT] Debug it isolation check: off (${current.reason})`,
    );
    return { ...current };
  }

  return {
    status() {
      return { ...current };
    },
    run() {
      if (!running) running = execute();
      return running;
    },
  };
}

let singleton: IsolationGate | undefined;

/** The isolation gate of this process. Story 3.7 refuses runs unless its state is `on`. */
export function getIsolationGate(env: Record<string, string | undefined> = process.env): IsolationGate {
  if (singleton) return singleton;
  singleton = createIsolationGate({
    githubApp: () => getGitHubApp(env),
    checkRunner: () => getIsolationCheckRunner(env),
    ...(debugItConfig.credentialsMode === 'organization'
      ? { organizationKey: () => env.DEBUG_IT_ANTHROPIC_API_KEY }
      : {}),
  });
  return singleton;
}

/** Test helper: forget the process-wide gate. */
export function resetIsolationGate(): void {
  singleton = undefined;
}
