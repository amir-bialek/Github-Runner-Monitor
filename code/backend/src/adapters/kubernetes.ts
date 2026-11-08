// The Kubernetes adapter (AD-1, AD-8, AD-9). The only code that talks to the
// Kubernetes API, and the only importer of @kubernetes/client-node.
//
// The Debug Job spec comes only from the chart-rendered template (the
// DEBUG_IT_JOB_TEMPLATE env var, from the debug-it-job-template ConfigMap).
// The backend fills in the run ID, the image tag, the Secret name and the
// limits, nothing else. A run starts by creating the Job, then one Secret
// owned by that Job holding the Anthropic key, the upload code and the result
// code; the pod waits in ContainerCreating until the Secret exists.
// The run lifecycle (story 3.10) reads a run's Job and pod through runStatus
// and lists run Jobs for the sweep through listRunJobs.
// The startup isolation check (story 3.6) runs a second chart-rendered
// template (DEBUG_IT_CHECK_JOB_TEMPLATE) with no Secret and no volume.
//
// Errors carry fixed messages only: never a Secret value, a code, a key or
// an API response body.
import { randomBytes } from 'node:crypto';
import type { V1Job, V1Secret } from '@kubernetes/client-node';

export class KubernetesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KubernetesError';
  }
}

/** Labels of every Debug Job and its pod; the chart renders the same. */
export const DEBUG_JOB_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'app.kubernetes.io/name': 'debug-it-job',
  'app.kubernetes.io/part-of': 'github-runner-monitor',
});
export const RUN_ID_LABEL = 'debug-it/run-id';

/** The containers and Secret volumes the template must have. */
export const CLAUDE_CONTAINER = 'claude';
export const RECEIVER_CONTAINER = 'receiver';
export const KEY_HELPER_CONTAINER = 'key-helper';
export const SECRET_VOLUMES = ['anthropic-key', 'upload-code', 'result-code'] as const;
/** Keys of the per-run Secret, one per Secret volume. */
export const SECRET_KEYS = {
  anthropicApiKey: 'anthropic-api-key',
  uploadCode: 'upload-code',
  resultCode: 'result-code',
} as const;

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

export interface EnvVar {
  name: string;
  value?: string;
  [key: string]: unknown;
}

export interface Container {
  name: string;
  image: string;
  env?: EnvVar[];
  [key: string]: unknown;
}

export interface Volume {
  name: string;
  secret?: { secretName?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface ObjectMeta {
  name?: string;
  namespace?: string;
  uid?: string;
  labels?: Record<string, string>;
  [key: string]: unknown;
}

export interface PodSpec {
  containers: Container[];
  initContainers: Container[];
  volumes: Volume[];
  [key: string]: unknown;
}

/** The parts of a batch/v1 Job this adapter reads or fills in. */
export interface Job {
  apiVersion: string;
  kind: 'Job';
  metadata: ObjectMeta;
  spec: {
    activeDeadlineSeconds?: number;
    template: { metadata: ObjectMeta; spec: PodSpec; [key: string]: unknown };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface Secret {
  apiVersion: 'v1';
  kind: 'Secret';
  metadata: ObjectMeta & {
    ownerReferences: Array<{
      apiVersion: string;
      kind: string;
      name: string;
      uid: string;
      controller: boolean;
    }>;
  };
  type: 'Opaque';
  immutable: true;
  data: Record<string, string>;
}

/** The calls the adapter makes, in the shape of the client-node object API. */
export interface KubernetesApi {
  createJob(params: { namespace: string; body: Job }): Promise<Job>;
  createSecret(params: { namespace: string; body: Secret }): Promise<unknown>;
  deleteJob(params: { name: string; namespace: string; propagationPolicy: 'Background' }): Promise<unknown>;
  readJob(params: { name: string; namespace: string }): Promise<JobState>;
  listJobs(params: { namespace: string; labelSelector: string }): Promise<{ items: JobState[] }>;
  listPods(params: { namespace: string; labelSelector: string }): Promise<{ items: PodState[] }>;
}

/** The port the receiver init container listens on (the chart's Debug Job template). */
export const RECEIVER_PORT = 8080;

/** What the lifecycle (story 3.10) reads of a run's Job and pod. */
export interface RunStatus {
  /** Whether the run's Job exists. */
  exists: boolean;
  /** Whether the Job has failed (a failed pod or a Failed condition). */
  failed: boolean;
  /** Whether the Job failed because activeDeadlineSeconds passed. */
  deadlineExceeded: boolean;
  /** The pod's IP, or null when it has none yet. */
  podIp: string | null;
  /** Whether the receiver init container is running. */
  receiverRunning: boolean;
  /**
   * When the pod ended (the claude container terminated, or the pod phase is
   * Succeeded or Failed), as ISO 8601 UTC; null while it has not ended.
   */
  podEndedAt: string | null;
}

export interface JobValues {
  runId: string;
  imageTag: string;
  secretName: string;
  timeLimitSeconds: number;
  /** When the wrapper must stop; sent as ISO 8601 UTC. */
  deadlineAt: Date;
  spendLimitUsd: number;
}

export interface SecretValues {
  runId: string;
  job: { name: string; uid: string };
  anthropicApiKey: string;
  uploadCode: string;
  resultCode: string;
}

export interface StartRunInput {
  runId: string;
  timeLimitSeconds: number;
  deadlineAt: Date;
  spendLimitUsd: number;
  anthropicApiKey: string;
  uploadCode: string;
  resultCode: string;
}

export interface StartedRun {
  jobName: string;
  secretName: string;
}

export interface KubernetesAdapter {
  /** Creates the Debug Job, then its Secret. Returns names only. */
  startRun(input: StartRunInput): Promise<StartedRun>;
  /** Deletes the run's Job (its pod and Secret go with it). A missing Job is fine. */
  deleteRun(runId: string): Promise<void>;
  /** The state of the run's Job and pod. A missing Job is `exists: false`. */
  runStatus(runId: string): Promise<RunStatus>;
  /** The run IDs of every Job with the Debug Job labels and a run ID label. */
  listRunJobs(): Promise<string[]>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(what: string): KubernetesError {
  return new KubernetesError(`The Debug Job template is not valid: ${what}.`);
}

function containerList(value: unknown, what: string, fail: (what: string) => KubernetesError = invalid): Container[] {
  if (!Array.isArray(value)) throw fail(`${what} is missing`);
  for (const container of value) {
    if (!isObject(container) || typeof container.name !== 'string') throw fail(`a container has no name`);
    if (typeof container.image !== 'string' || container.image === '') throw fail('a container has no image');
    // The template names the image without tag; the backend adds it.
    const lastSegment = container.image.split('/').pop() ?? '';
    if (lastSegment.includes(':') || container.image.includes('@')) throw fail('a container image carries a tag');
    if (container.env !== undefined && !Array.isArray(container.env)) throw fail('a container env is not a list');
  }
  return value as Container[];
}

/** Parses the chart-rendered Job template and checks its shape. */
export function parseJobTemplate(json: string): Job {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw invalid('it is not JSON');
  }
  if (!isObject(parsed) || parsed.kind !== 'Job' || parsed.apiVersion !== 'batch/v1') throw invalid('it is not a Job');
  if (!isObject(parsed.metadata)) throw invalid('the Job metadata is missing');
  const spec = parsed.spec;
  if (!isObject(spec) || !isObject(spec.template)) throw invalid('the pod template is missing');
  if (!isObject(spec.template.metadata)) throw invalid('the pod metadata is missing');
  const pod = spec.template.spec;
  if (!isObject(pod)) throw invalid('the pod spec is missing');
  const containers = containerList(pod.containers, 'the containers list');
  const initContainers = containerList(pod.initContainers, 'the init containers list');
  if (!containers.some((c) => c.name === CLAUDE_CONTAINER)) throw invalid('the claude container is missing');
  if (!initContainers.some((c) => c.name === RECEIVER_CONTAINER)) throw invalid('the receiver init container is missing');
  if (!initContainers.some((c) => c.name === KEY_HELPER_CONTAINER)) throw invalid('the key helper sidecar is missing');
  if (!Array.isArray(pod.volumes)) throw invalid('the volumes list is missing');
  const volumes = pod.volumes as unknown[];
  for (const name of SECRET_VOLUMES) {
    const volume = volumes.find((v) => isObject(v) && v.name === name);
    if (!isObject(volume) || !isObject(volume.secret)) throw invalid(`the ${name} Secret volume is missing`);
  }
  return parsed as unknown as Job;
}

function checkRunId(runId: string): void {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new KubernetesError('The run ID is not valid.');
}

function checkImageTag(imageTag: string): void {
  if (typeof imageTag !== 'string' || !IMAGE_TAG.test(imageTag)) {
    throw new KubernetesError('The Debug Job image tag is not valid.');
  }
}

export function jobName(runId: string): string {
  return `debug-it-${runId}`;
}

function setEnv(container: Container, name: string, value: string): void {
  const env = container.env ?? (container.env = []);
  const entry = env.find((e) => e.name === name);
  if (entry) {
    entry.value = value;
  } else {
    env.push({ name, value });
  }
}

/**
 * The Job for one run, from a deep copy of the template. Sets the name, the
 * run ID label, the image tag, activeDeadlineSeconds, the Secret name on the
 * three Secret volumes and the claude container's RUN_ID, DEADLINE_AT and
 * SPEND_LIMIT_USD. Nothing else changes.
 */
export function buildJob(template: Job, values: JobValues): Job {
  checkRunId(values.runId);
  checkImageTag(values.imageTag);
  if (!Number.isInteger(values.timeLimitSeconds) || values.timeLimitSeconds < 1) {
    throw new KubernetesError('The Debug Job time limit is not valid.');
  }
  if (!(values.deadlineAt instanceof Date) || Number.isNaN(values.deadlineAt.getTime())) {
    throw new KubernetesError('The Debug Job deadline is not valid.');
  }
  if (!Number.isFinite(values.spendLimitUsd) || values.spendLimitUsd <= 0) {
    throw new KubernetesError('The Debug Job spend limit is not valid.');
  }
  const job = structuredClone(template);
  job.metadata.name = jobName(values.runId);
  job.metadata.labels = { ...job.metadata.labels, [RUN_ID_LABEL]: values.runId };
  job.spec.template.metadata.labels = { ...job.spec.template.metadata.labels, [RUN_ID_LABEL]: values.runId };
  job.spec.activeDeadlineSeconds = values.timeLimitSeconds;
  const pod = job.spec.template.spec;
  for (const container of [...pod.initContainers, ...pod.containers]) {
    container.image = `${container.image}:${values.imageTag}`;
  }
  for (const volume of pod.volumes) {
    if ((SECRET_VOLUMES as readonly string[]).includes(volume.name) && volume.secret) {
      volume.secret.secretName = values.secretName;
    }
  }
  const claude = pod.containers.find((c) => c.name === CLAUDE_CONTAINER);
  if (!claude) throw invalid('the claude container is missing');
  setEnv(claude, 'RUN_ID', values.runId);
  setEnv(claude, 'DEADLINE_AT', values.deadlineAt.toISOString());
  setEnv(claude, 'SPEND_LIMIT_USD', String(values.spendLimitUsd));
  return job;
}

function base64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

/** The per-run Secret, owned by the run's Job so it is deleted with it. */
export function buildSecret(values: SecretValues): Secret {
  checkRunId(values.runId);
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: jobName(values.runId),
      labels: { ...DEBUG_JOB_LABELS, [RUN_ID_LABEL]: values.runId },
      ownerReferences: [
        {
          apiVersion: 'batch/v1',
          kind: 'Job',
          name: values.job.name,
          uid: values.job.uid,
          controller: true,
        },
      ],
    },
    type: 'Opaque',
    immutable: true,
    data: {
      [SECRET_KEYS.anthropicApiKey]: base64(values.anthropicApiKey),
      [SECRET_KEYS.uploadCode]: base64(values.uploadCode),
      [SECRET_KEYS.resultCode]: base64(values.resultCode),
    },
  };
}

function statusCode(error: unknown): number | undefined {
  if (!isObject(error)) return undefined;
  if (typeof error.code === 'number') return error.code;
  if (typeof error.statusCode === 'number') return error.statusCode;
  return undefined;
}

export interface KubernetesAdapterOptions {
  namespace: string;
  template: Job;
  imageTag: string;
  api: KubernetesApi;
  /** The clock for podEndedAt when the pod gives no finish time. */
  now?: () => Date;
}

function isoTime(value: unknown): string | null {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

/** The label selector of every Debug Job of a run (not the isolation check Job). */
export function runJobSelector(): string {
  return [...Object.entries(DEBUG_JOB_LABELS).map(([k, v]) => `${k}=${v}`), RUN_ID_LABEL].join(',');
}

export function createKubernetesAdapter(options: KubernetesAdapterOptions): KubernetesAdapter {
  const { namespace, template, imageTag, api } = options;
  const now = options.now ?? (() => new Date());

  function podStatus(pods: PodState[], status: RunStatus): void {
    // backoffLimit is 0, so there is one pod; prefer one that has an IP.
    const pod = pods.find((p) => typeof p?.status?.podIP === 'string' && p.status.podIP !== '') ?? pods[0];
    const s = pod?.status;
    if (!s) return;
    status.podIp = typeof s.podIP === 'string' && s.podIP !== '' ? s.podIP : null;
    const receiver = s.initContainerStatuses?.find((c) => c?.name === RECEIVER_CONTAINER);
    status.receiverRunning = !!receiver?.state?.running;
    const claude = s.containerStatuses?.find((c) => c?.name === CLAUDE_CONTAINER);
    const terminated = claude?.state?.terminated;
    if (terminated) {
      status.podEndedAt = isoTime(terminated.finishedAt) ?? now().toISOString();
    } else if (s.phase === 'Succeeded' || s.phase === 'Failed') {
      status.podEndedAt = now().toISOString();
    }
  }

  async function deleteJobQuietly(name: string): Promise<void> {
    try {
      await api.deleteJob({ name, namespace, propagationPolicy: 'Background' });
    } catch {
      // The sweep (story 3.10) removes whatever is left.
    }
  }

  return {
    async startRun(input) {
      checkRunId(input.runId);
      checkImageTag(imageTag);
      const name = jobName(input.runId);
      const body = buildJob(template, {
        runId: input.runId,
        imageTag,
        secretName: name,
        timeLimitSeconds: input.timeLimitSeconds,
        deadlineAt: input.deadlineAt,
        spendLimitUsd: input.spendLimitUsd,
      });

      let created: Job;
      try {
        created = await api.createJob({ namespace, body });
      } catch {
        // The server may have stored the Job before the call failed.
        await deleteJobQuietly(name);
        throw new KubernetesError('The Debug Job could not be created.');
      }
      const uid = created?.metadata?.uid;
      if (typeof uid !== 'string' || uid === '') {
        await deleteJobQuietly(name);
        throw new KubernetesError('The Debug Job could not be created.');
      }

      try {
        await api.createSecret({
          namespace,
          body: buildSecret({
            runId: input.runId,
            job: { name, uid },
            anthropicApiKey: input.anthropicApiKey,
            uploadCode: input.uploadCode,
            resultCode: input.resultCode,
          }),
        });
      } catch {
        await deleteJobQuietly(name);
        throw new KubernetesError('The Debug Job Secret could not be created.');
      }
      return { jobName: name, secretName: name };
    },

    async deleteRun(runId) {
      checkRunId(runId);
      try {
        await api.deleteJob({ name: jobName(runId), namespace, propagationPolicy: 'Background' });
      } catch (error) {
        if (statusCode(error) === 404) return;
        throw new KubernetesError('The Debug Job could not be deleted.');
      }
    },

    async runStatus(runId) {
      checkRunId(runId);
      const status: RunStatus = {
        exists: false,
        failed: false,
        deadlineExceeded: false,
        podIp: null,
        receiverRunning: false,
        podEndedAt: null,
      };
      let job: JobState;
      try {
        job = await api.readJob({ name: jobName(runId), namespace });
      } catch (error) {
        if (statusCode(error) === 404) return status;
        throw new KubernetesError('The Debug Job could not be read.');
      }
      status.exists = true;
      const failedCondition = (job?.status?.conditions ?? []).find((c) => c?.type === 'Failed' && c.status === 'True');
      status.failed = count(job?.status?.failed) >= 1 || !!failedCondition;
      status.deadlineExceeded = failedCondition?.reason === 'DeadlineExceeded';
      let pods: { items: PodState[] };
      try {
        pods = await api.listPods({ namespace, labelSelector: `${RUN_ID_LABEL}=${runId}` });
      } catch {
        throw new KubernetesError('The Debug Job pod could not be read.');
      }
      podStatus(Array.isArray(pods?.items) ? pods.items : [], status);
      // A completed Job whose pod is no longer listed has ended too.
      const complete = (job?.status?.conditions ?? []).some((c) => c?.type === 'Complete' && c.status === 'True');
      if (status.podEndedAt === null && (count(job?.status?.succeeded) >= 1 || complete)) {
        status.podEndedAt = now().toISOString();
      }
      return status;
    },

    async listRunJobs() {
      let jobs: { items: JobState[] };
      try {
        jobs = await api.listJobs({ namespace, labelSelector: runJobSelector() });
      } catch {
        throw new KubernetesError('The Debug Jobs could not be listed.');
      }
      const ids = new Set<string>();
      for (const job of Array.isArray(jobs?.items) ? jobs.items : []) {
        const labels = job?.metadata?.labels ?? {};
        const matches = Object.entries(DEBUG_JOB_LABELS).every(([k, v]) => labels[k] === v);
        const runId = labels[RUN_ID_LABEL];
        if (matches && typeof runId === 'string' && RUN_ID.test(runId)) ids.add(runId);
      }
      return [...ids].sort();
    },
  };
}

// --- startup isolation check Job (story 3.6, FR31, AD-7) ---
//
// A second chart-rendered template (DEBUG_IT_CHECK_JOB_TEMPLATE, key
// check-job.json of the debug-it-job-template ConfigMap). The check Job
// carries the Debug Job labels, so the debug-it-job NetworkPolicy applies to
// it unchanged; it has no Secret and no volume. The backend fills in only the
// name and the image tag, waits for it at most 2 minutes and always deletes it.

export const CHECK_CONTAINER = 'isolation-check';
export const CHECK_TIMEOUT_MS = 120_000;
export const CHECK_POLL_MS = 2_000;
const CHECK_ID = /^[0-9a-f]{8}$/;

export type CheckOutcome =
  | { status: 'passed' }
  | { status: 'failed'; exitCode: number | null }
  | { status: 'timeout' }
  | { status: 'not-started' };

export interface IsolationCheckRunner {
  /** Runs one check Job to its end or the timeout; never rejects. */
  run(): Promise<CheckOutcome>;
}

/** What the runner reads of a Job's status. */
export interface JobState {
  metadata?: { name?: string; labels?: Record<string, string>; [key: string]: unknown };
  status?: {
    succeeded?: number;
    failed?: number;
    conditions?: Array<{ type?: string; status?: string; reason?: string; [key: string]: unknown }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** One container status of a pod. */
export interface ContainerStatus {
  name: string;
  state?: {
    running?: { [key: string]: unknown };
    terminated?: { exitCode?: number; finishedAt?: string | Date; [key: string]: unknown };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** What the runner reads of a pod. */
export interface PodState {
  status?: {
    phase?: string;
    podIP?: string;
    containerStatuses?: ContainerStatus[];
    initContainerStatuses?: ContainerStatus[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** The calls the check runner makes, in the shape of the client-node object API. */
export interface CheckJobApi {
  createJob(params: { namespace: string; body: Job }): Promise<Job>;
  readJob(params: { name: string; namespace: string }): Promise<JobState>;
  listPods(params: { namespace: string; labelSelector: string }): Promise<{ items: PodState[] }>;
  deleteJob(params: { name: string; namespace: string; propagationPolicy: 'Background' }): Promise<unknown>;
}

function invalidCheck(what: string): KubernetesError {
  return new KubernetesError(`The isolation check Job template is not valid: ${what}.`);
}

/** Parses the chart-rendered check Job template and checks its shape. */
export function parseCheckJobTemplate(json: string): Job {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw invalidCheck('it is not JSON');
  }
  if (!isObject(parsed) || parsed.kind !== 'Job' || parsed.apiVersion !== 'batch/v1') throw invalidCheck('it is not a Job');
  if (!isObject(parsed.metadata)) throw invalidCheck('the Job metadata is missing');
  const spec = parsed.spec;
  if (!isObject(spec) || !isObject(spec.template)) throw invalidCheck('the pod template is missing');
  if (!isObject(spec.template.metadata)) throw invalidCheck('the pod metadata is missing');
  const pod = spec.template.spec;
  if (!isObject(pod)) throw invalidCheck('the pod spec is missing');
  const containers = containerList(pod.containers, 'the containers list', invalidCheck);
  if (containers.length !== 1 || containers[0]?.name !== CHECK_CONTAINER) {
    throw invalidCheck('it must have exactly one container, isolation-check');
  }
  if (pod.initContainers !== undefined && (!Array.isArray(pod.initContainers) || pod.initContainers.length > 0)) {
    throw invalidCheck('it must have no init containers');
  }
  if (pod.volumes !== undefined && (!Array.isArray(pod.volumes) || pod.volumes.length > 0)) {
    throw invalidCheck('it must have no volumes');
  }
  return parsed as unknown as Job;
}

export function checkJobName(checkId: string): string {
  return `debug-it-check-${checkId}`;
}

/** The check Job, from a deep copy of the template: only the name and the image tag change. */
export function buildCheckJob(template: Job, values: { checkId: string; imageTag: string }): Job {
  if (typeof values.checkId !== 'string' || !CHECK_ID.test(values.checkId)) {
    throw new KubernetesError('The isolation check ID is not valid.');
  }
  checkImageTag(values.imageTag);
  const job = structuredClone(template);
  job.metadata.name = checkJobName(values.checkId);
  for (const container of job.spec.template.spec.containers) {
    container.image = `${container.image}:${values.imageTag}`;
  }
  return job;
}

/** Bound of the final delete; a hung delete is left to ttlSecondsAfterFinished. */
export const CHECK_DELETE_MS = 10_000;
/** The least time the pod list read gets, even at the deadline. */
const CHECK_MIN_CALL_MS = 1_000;
const HUNG = Symbol('hung');

/** The call's result, or HUNG when it has not settled within ms (real time). */
function bounded<T>(call: () => Promise<T>, ms: number): Promise<T | typeof HUNG> {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => done(HUNG), Math.max(0, ms));
    let pending: Promise<T>;
    try {
      pending = call();
    } catch (error) {
      clearTimeout(timer);
      fail(error);
      return;
    }
    pending.then(
      (value) => {
        clearTimeout(timer);
        done(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        fail(error);
      },
    );
  });
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export interface IsolationCheckRunnerOptions {
  namespace: string;
  template: Job;
  imageTag: string;
  api: CheckJobApi;
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function createIsolationCheckRunner(options: IsolationCheckRunnerOptions): IsolationCheckRunner {
  const { namespace, template, imageTag, api } = options;
  const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
  const pollMs = options.pollMs ?? CHECK_POLL_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, Math.max(0, ms))));
  const now = options.now ?? Date.now;
  // Every cluster call is bounded, so run() ends shortly after timeoutMs even
  // when a call never settles.

  async function exitCode(name: string, deadline: number): Promise<number | null> {
    try {
      const pods = await bounded(
        () => api.listPods({ namespace, labelSelector: `job-name=${name}` }),
        Math.max(deadline - now(), CHECK_MIN_CALL_MS),
      );
      if (pods === HUNG) return null;
      for (const pod of pods?.items ?? []) {
        const status = pod?.status?.containerStatuses?.find((c) => c?.name === CHECK_CONTAINER);
        const code = status?.state?.terminated?.exitCode;
        if (typeof code === 'number' && Number.isInteger(code)) return code;
      }
    } catch {
      // unreadable: the generic failed reason applies
    }
    return null;
  }

  async function wait(name: string, deadline: number): Promise<CheckOutcome> {
    for (;;) {
      let state: JobState | typeof HUNG | undefined;
      try {
        state = await bounded(() => api.readJob({ name, namespace }), Math.max(deadline - now(), 0));
      } catch {
        // A failed read is retried until the timeout.
        state = undefined;
      }
      if (state === HUNG) return { status: 'timeout' };
      if (count(state?.status?.succeeded) >= 1) return { status: 'passed' };
      if (count(state?.status?.failed) >= 1) return { status: 'failed', exitCode: await exitCode(name, deadline) };
      const left = deadline - now();
      if (left <= 0) return { status: 'timeout' };
      await sleep(Math.min(pollMs, left));
    }
  }

  return {
    async run() {
      const deadline = now() + timeoutMs;
      let name: string;
      let body: Job;
      try {
        const checkId = randomBytes(4).toString('hex');
        name = checkJobName(checkId);
        body = buildCheckJob(template, { checkId, imageTag });
      } catch {
        return { status: 'not-started' };
      }
      try {
        try {
          const created = await bounded(() => api.createJob({ namespace, body }), Math.max(deadline - now(), 0));
          if (created === HUNG) return { status: 'not-started' };
        } catch {
          return { status: 'not-started' };
        }
        return await wait(name, deadline);
      } finally {
        // Also after a failed create: the server may have stored the Job.
        try {
          await bounded(() => api.deleteJob({ name, namespace, propagationPolicy: 'Background' }), CHECK_DELETE_MS);
        } catch {
          // ttlSecondsAfterFinished removes whatever is left.
        }
      }
    },
  };
}

// Loads the SDK only when first used, so tests and mock mode never need it.
// The backend runs in the cluster with its own ServiceAccount token.
function createClusterApi(): KubernetesApi & CheckJobApi {
  type Clients = {
    batch: import('@kubernetes/client-node').BatchV1Api;
    core: import('@kubernetes/client-node').CoreV1Api;
  };
  let loaded: Promise<Clients> | undefined;
  const load = (): Promise<Clients> => {
    if (!loaded) {
      loaded = import('@kubernetes/client-node').then((k8s) => {
        const config = new k8s.KubeConfig();
        config.loadFromCluster();
        return { batch: config.makeApiClient(k8s.BatchV1Api), core: config.makeApiClient(k8s.CoreV1Api) };
      });
      loaded.catch(() => {
        loaded = undefined;
      });
    }
    return loaded;
  };
  return {
    async createJob({ namespace, body }) {
      const { batch } = await load();
      const job = await batch.createNamespacedJob({ namespace, body: body as unknown as V1Job });
      return job as unknown as Job;
    },
    async createSecret({ namespace, body }) {
      const { core } = await load();
      await core.createNamespacedSecret({ namespace, body: body as unknown as V1Secret });
    },
    async deleteJob({ name, namespace, propagationPolicy }) {
      const { batch } = await load();
      await batch.deleteNamespacedJob({ name, namespace, propagationPolicy });
    },
    async readJob({ name, namespace }) {
      const { batch } = await load();
      const job = await batch.readNamespacedJob({ name, namespace });
      return job as unknown as JobState;
    },
    async listJobs({ namespace, labelSelector }) {
      const { batch } = await load();
      const jobs = await batch.listNamespacedJob({ namespace, labelSelector });
      return jobs as unknown as { items: JobState[] };
    },
    async listPods({ namespace, labelSelector }) {
      const { core } = await load();
      const pods = await core.listNamespacedPod({ namespace, labelSelector });
      return pods as unknown as { items: PodState[] };
    },
  };
}

/** Mock mode (AD-16): checks the run ID only, touches no cluster. */
export function createMockKubernetesAdapter(): KubernetesAdapter & { runs(): string[] } {
  const runs = new Set<string>();
  return {
    async startRun(input) {
      checkRunId(input.runId);
      const name = jobName(input.runId);
      runs.add(name);
      return { jobName: name, secretName: name };
    },
    async deleteRun(runId) {
      checkRunId(runId);
      runs.delete(jobName(runId));
    },
    async runStatus(runId) {
      checkRunId(runId);
      return {
        exists: runs.has(jobName(runId)),
        failed: false,
        deadlineExceeded: false,
        podIp: null,
        receiverRunning: false,
        podEndedAt: null,
      };
    },
    async listRunJobs() {
      return [...runs].map((name) => name.slice('debug-it-'.length)).sort();
    },
    runs() {
      return [...runs];
    },
  };
}

let singleton: KubernetesAdapter | undefined;

/** The adapter for this process, built from the environment on first use. */
export function getKubernetesAdapter(env: Record<string, string | undefined> = process.env): KubernetesAdapter {
  if (singleton) return singleton;
  if (env.USE_MOCK_DATA === 'true') {
    singleton = createMockKubernetesAdapter();
    return singleton;
  }
  const templateJson = env.DEBUG_IT_JOB_TEMPLATE;
  const imageTag = env.DEBUG_JOB_IMAGE_TAG?.trim();
  const namespace = env.DEBUG_IT_NAMESPACE?.trim();
  if (!templateJson || !imageTag || !namespace) {
    throw new KubernetesError('The Debug Job template, image tag or namespace is not configured.');
  }
  checkImageTag(imageTag);
  singleton = createKubernetesAdapter({
    namespace,
    template: parseJobTemplate(templateJson),
    imageTag,
    api: createClusterApi(),
  });
  return singleton;
}

/** Test helper: forget the process-wide adapter. */
export function resetKubernetesAdapter(): void {
  singleton = undefined;
}

let checkRunner: IsolationCheckRunner | undefined;

/**
 * The isolation check runner for this process, built from the environment on
 * first use. Mock mode (AD-16) always passes and touches no cluster.
 */
export function getIsolationCheckRunner(env: Record<string, string | undefined> = process.env): IsolationCheckRunner {
  if (checkRunner) return checkRunner;
  if (env.USE_MOCK_DATA === 'true') {
    checkRunner = { run: async () => ({ status: 'passed' }) };
    return checkRunner;
  }
  const templateJson = env.DEBUG_IT_CHECK_JOB_TEMPLATE;
  const imageTag = env.DEBUG_JOB_IMAGE_TAG?.trim();
  const namespace = env.DEBUG_IT_NAMESPACE?.trim();
  if (!templateJson || !imageTag || !namespace) {
    throw new KubernetesError('The isolation check Job template, image tag or namespace is not configured.');
  }
  checkImageTag(imageTag);
  checkRunner = createIsolationCheckRunner({
    namespace,
    template: parseCheckJobTemplate(templateJson),
    imageTag,
    api: createClusterApi(),
  });
  return checkRunner;
}

/** Test helper: forget the process-wide isolation check runner. */
export function resetIsolationCheckRunner(): void {
  checkRunner = undefined;
}
