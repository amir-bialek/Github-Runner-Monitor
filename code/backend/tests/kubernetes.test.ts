import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildCheckJob,
  buildJob,
  buildSecret,
  CHECK_CONTAINER,
  createIsolationCheckRunner,
  createKubernetesAdapter,
  createMockKubernetesAdapter,
  RECEIVER_PORT,
  runJobSelector,
  DEBUG_JOB_LABELS,
  getIsolationCheckRunner,
  getKubernetesAdapter,
  KubernetesError,
  parseCheckJobTemplate,
  parseJobTemplate,
  resetIsolationCheckRunner,
  resetKubernetesAdapter,
  type CheckJobApi,
  type Container,
  type Job,
  type JobState,
  type KubernetesApi,
  type PodState,
  type Secret,
} from '../src/adapters/kubernetes';

// Mirrors the chart's debug-it-job-template ConfigMap (helm/chart/templates/_helpers.tpl).
const TEMPLATE_JSON = readFileSync(resolve(process.cwd(), 'tests/fixtures/debug-job-template.json'), 'utf8');
// Mirrors the chart's check-job.json (story 3.6).
const CHECK_TEMPLATE_JSON = readFileSync(resolve(process.cwd(), 'tests/fixtures/debug-check-job-template.json'), 'utf8');

const RUN_ID = '3f1c2b7a-9d4e-4c1a-8b2f-6e5d4c3b2a10';
const JOB_NAME = `debug-it-${RUN_ID}`;
const JOB_UID = 'b0c1d2e3-0000-4000-8000-acme00000001';
// Fake values only; each one must never appear in an error.
const ANTHROPIC_KEY = 'sk-ant-fake-acme-payments-api-key';
const UPLOAD_CODE = 'fake-upload-code-0123456789abcdef';
const RESULT_CODE = 'fake-result-code-fedcba9876543210';
const DEADLINE = new Date('2026-11-05T10:15:00.000Z');

function template(): Job {
  return parseJobTemplate(TEMPLATE_JSON);
}

function startInput() {
  return {
    runId: RUN_ID,
    timeLimitSeconds: 900,
    deadlineAt: DEADLINE,
    spendLimitUsd: 2.5,
    anthropicApiKey: ANTHROPIC_KEY,
    uploadCode: UPLOAD_CODE,
    resultCode: RESULT_CODE,
  };
}

interface FakeApi extends KubernetesApi {
  calls: string[];
  jobs: Job[];
  secrets: Secret[];
  deletes: Array<{ name: string; namespace: string; propagationPolicy: string }>;
  selectors: string[];
}

function fakeApi(overrides: Partial<KubernetesApi> = {}): FakeApi {
  const api: FakeApi = {
    calls: [],
    jobs: [],
    secrets: [],
    deletes: [],
    selectors: [],
    async readJob(params) {
      api.calls.push(`readJob:${params.namespace}`);
      if (overrides.readJob) return overrides.readJob(params);
      return { status: {} };
    },
    async listJobs(params) {
      api.calls.push(`listJobs:${params.namespace}`);
      api.selectors.push(params.labelSelector);
      if (overrides.listJobs) return overrides.listJobs(params);
      return { items: [] };
    },
    async listPods(params) {
      api.calls.push(`listPods:${params.namespace}`);
      api.selectors.push(params.labelSelector);
      if (overrides.listPods) return overrides.listPods(params);
      return { items: [] };
    },
    async createJob({ namespace, body }) {
      api.calls.push(`createJob:${namespace}`);
      api.jobs.push(body);
      if (overrides.createJob) return overrides.createJob({ namespace, body });
      return { ...body, metadata: { ...body.metadata, uid: JOB_UID } };
    },
    async createSecret({ namespace, body }) {
      api.calls.push(`createSecret:${namespace}`);
      api.secrets.push(body);
      if (overrides.createSecret) return overrides.createSecret({ namespace, body });
      return body;
    },
    async deleteJob(params) {
      api.calls.push(`deleteJob:${params.namespace}`);
      api.deletes.push(params);
      if (overrides.deleteJob) return overrides.deleteJob(params);
      return {};
    },
  };
  return api;
}

function adapter(api: KubernetesApi, imageTag = '1.2.0') {
  return createKubernetesAdapter({ namespace: 'debug-it', template: template(), imageTag, api });
}

function allContainers(job: Job): Container[] {
  return [...job.spec.template.spec.initContainers, ...job.spec.template.spec.containers];
}

function container(job: Job, name: string): Container {
  const found = allContainers(job).find((c) => c.name === name);
  if (!found) throw new Error(`no container ${name}`);
  return found;
}

function mounts(c: Container): string[] {
  return ((c.volumeMounts as Array<{ name: string }>) ?? []).map((m) => m.name).sort();
}

function env(c: Container): Record<string, string | undefined> {
  return Object.fromEntries((c.env ?? []).map((e) => [e.name, e.value]));
}

function expectNoSecretIn(error: unknown) {
  const text = `${(error as Error).message} ${JSON.stringify(error)}`;
  for (const value of [ANTHROPIC_KEY, UPLOAD_CODE, RESULT_CODE]) {
    expect(text).not.toContain(value);
    expect(text).not.toContain(Buffer.from(value).toString('base64'));
  }
}

describe('parseJobTemplate', () => {
  test('accepts the chart template', () => {
    const job = template();
    expect(job.kind).toBe('Job');
    expect(job.spec.template.spec.initContainers.map((c) => c.name)).toEqual(['receiver', 'key-helper']);
    expect(job.spec.template.spec.containers.map((c) => c.name)).toEqual(['claude']);
  });

  test('the chart template keeps the pod locked down', () => {
    const job = template();
    const pod = job.spec.template.spec;
    expect(job.spec.backoffLimit).toBe(0);
    expect(job.spec.ttlSecondsAfterFinished).toBe(300);
    expect(pod.restartPolicy).toBe('Never');
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.enableServiceLinks).toBe(false);
    expect(container(job, 'key-helper').restartPolicy).toBe('Always');
    for (const c of allContainers(job)) {
      expect(c.securityContext).toEqual({
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        runAsNonRoot: true,
        capabilities: { drop: ['ALL'] },
      });
    }
  });

  const broken: Array<[string, (t: Record<string, any>) => unknown]> = [
    ['not a Job', (t) => ({ ...t, kind: 'Pod' })],
    ['no claude container', (t) => {
      t.spec.template.spec.containers = [];
      return t;
    }],
    ['no receiver', (t) => {
      t.spec.template.spec.initContainers = t.spec.template.spec.initContainers.filter((c: Container) => c.name !== 'receiver');
      return t;
    }],
    ['no key helper', (t) => {
      t.spec.template.spec.initContainers = t.spec.template.spec.initContainers.filter((c: Container) => c.name !== 'key-helper');
      return t;
    }],
    ['missing secret volume', (t) => {
      t.spec.template.spec.volumes = t.spec.template.spec.volumes.filter((v: { name: string }) => v.name !== 'result-code');
      return t;
    }],
    ['image with a tag', (t) => {
      t.spec.template.spec.containers[0].image = 'acme/debug-job:evil';
      return t;
    }],
  ];

  test.each(broken)('refuses a template with %s', (_name, change) => {
    const json = JSON.stringify(change(JSON.parse(TEMPLATE_JSON)));
    expect(() => parseJobTemplate(json)).toThrow(KubernetesError);
  });

  test('refuses text that is not JSON with a fixed message', () => {
    expect(() => parseJobTemplate('apiVersion: batch/v1')).toThrow('The Debug Job template is not valid: it is not JSON.');
  });
});

describe('buildJob', () => {
  const values = {
    runId: RUN_ID,
    imageTag: '1.2.0',
    secretName: JOB_NAME,
    timeLimitSeconds: 900,
    deadlineAt: DEADLINE,
    spendLimitUsd: 2.5,
  };

  test('fills in only the run values', () => {
    const tpl = template();
    const job = buildJob(tpl, values);
    expect(job.metadata.name).toBe(JOB_NAME);
    expect(job.metadata.labels).toEqual({
      'app.kubernetes.io/name': 'debug-it-job',
      'app.kubernetes.io/part-of': 'github-runner-monitor',
      'debug-it/run-id': RUN_ID,
    });
    expect(job.spec.template.metadata.labels?.['debug-it/run-id']).toBe(RUN_ID);
    expect(job.spec.activeDeadlineSeconds).toBe(900);
    for (const c of allContainers(job)) expect(c.image).toBe('acme/debug-job:1.2.0');
    for (const v of job.spec.template.spec.volumes.filter((v) => v.secret)) {
      expect(v.secret?.secretName).toBe(JOB_NAME);
    }
    const claude = env(container(job, 'claude'));
    expect(claude.RUN_ID).toBe(RUN_ID);
    expect(claude.DEADLINE_AT).toBe('2026-11-05T10:15:00.000Z');
    expect(claude.SPEND_LIMIT_USD).toBe('2.5');
    expect(claude.RESULTS_URL).toBe('http://backend.default.svc.cluster.local:3002');

    // Everything else is the template, unchanged.
    const expected = JSON.parse(TEMPLATE_JSON);
    expected.metadata.name = JOB_NAME;
    expected.metadata.labels['debug-it/run-id'] = RUN_ID;
    expected.spec.template.metadata.labels['debug-it/run-id'] = RUN_ID;
    expected.spec.activeDeadlineSeconds = 900;
    const pod = expected.spec.template.spec;
    for (const c of [...pod.initContainers, ...pod.containers]) c.image = `${c.image}:1.2.0`;
    for (const v of pod.volumes) if (v.secret) v.secret.secretName = JOB_NAME;
    for (const e of pod.containers[0].env) {
      if (e.name === 'RUN_ID') e.value = RUN_ID;
      if (e.name === 'DEADLINE_AT') e.value = '2026-11-05T10:15:00.000Z';
      if (e.name === 'SPEND_LIMIT_USD') e.value = '2.5';
    }
    expect(job).toEqual(expected);
  });

  test('each Secret item is mounted only into its own container', () => {
    const job = buildJob(template(), values);
    expect(mounts(container(job, 'receiver'))).toEqual(['upload-code', 'work']);
    expect(mounts(container(job, 'key-helper'))).toEqual(['anthropic-key']);
    expect(mounts(container(job, 'claude'))).toEqual(['result-code', 'work', 'wrapper']);
    const items = Object.fromEntries(
      job.spec.template.spec.volumes
        .filter((v) => v.secret)
        .map((v) => [v.name, (v.secret?.items as Array<{ key: string }>).map((i) => i.key)]),
    );
    expect(items).toEqual({
      'anthropic-key': ['anthropic-api-key'],
      'upload-code': ['upload-code'],
      'result-code': ['result-code'],
    });
    // The claude container never holds the key.
    expect(Object.keys(env(container(job, 'claude')))).not.toContain('ANTHROPIC_API_KEY');
  });

  test('leaves the template untouched and builds independent Jobs', () => {
    const tpl = template();
    const before = JSON.stringify(tpl);
    const a = buildJob(tpl, values);
    const b = buildJob(tpl, { ...values, runId: '9a8b7c6d-1111-4222-8333-444455556666', imageTag: '1.3.0' });
    expect(JSON.stringify(tpl)).toBe(before);
    a.spec.template.spec.containers[0]!.image = 'changed';
    expect(b.spec.template.spec.containers[0]!.image).toBe('acme/debug-job:1.3.0');
    expect(a.metadata.name).not.toBe(b.metadata.name);
  });

  test.each([
    ['runId', { runId: '../x' }],
    ['imageTag', { imageTag: 'latest:evil' }],
    ['time limit', { timeLimitSeconds: 0 }],
    ['spend limit', { spendLimitUsd: Number.NaN }],
  ])('refuses a bad %s', (_name, change) => {
    expect(() => buildJob(template(), { ...values, ...change })).toThrow(KubernetesError);
  });
});

describe('buildSecret', () => {
  test('holds the three values, owned by the Job', () => {
    const secret = buildSecret({
      runId: RUN_ID,
      job: { name: JOB_NAME, uid: JOB_UID },
      anthropicApiKey: ANTHROPIC_KEY,
      uploadCode: UPLOAD_CODE,
      resultCode: RESULT_CODE,
    });
    expect(secret).toEqual({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: JOB_NAME,
        labels: {
          'app.kubernetes.io/name': 'debug-it-job',
          'app.kubernetes.io/part-of': 'github-runner-monitor',
          'debug-it/run-id': RUN_ID,
        },
        ownerReferences: [
          { apiVersion: 'batch/v1', kind: 'Job', name: JOB_NAME, uid: JOB_UID, controller: true },
        ],
      },
      type: 'Opaque',
      immutable: true,
      data: {
        'anthropic-api-key': Buffer.from(ANTHROPIC_KEY).toString('base64'),
        'upload-code': Buffer.from(UPLOAD_CODE).toString('base64'),
        'result-code': Buffer.from(RESULT_CODE).toString('base64'),
      },
    });
  });
});

describe('createKubernetesAdapter', () => {
  test('startRun creates the Job first, then the Secret owned by it', async () => {
    const api = fakeApi();
    const result = await adapter(api).startRun(startInput());
    expect(result).toEqual({ jobName: JOB_NAME, secretName: JOB_NAME });
    expect(api.calls).toEqual(['createJob:debug-it', 'createSecret:debug-it']);
    const job = api.jobs[0]!;
    expect(job.metadata.name).toBe(JOB_NAME);
    for (const c of allContainers(job)) expect(c.image).toBe('acme/debug-job:1.2.0');
    expect(job.spec.activeDeadlineSeconds).toBe(900);
    expect(env(container(job, 'claude')).DEADLINE_AT).toBe(DEADLINE.toISOString());
    const secret = api.secrets[0]!;
    expect(secret.metadata.name).toBe(JOB_NAME);
    expect(secret.metadata.ownerReferences).toEqual([
      { apiVersion: 'batch/v1', kind: 'Job', name: JOB_NAME, uid: JOB_UID, controller: true },
    ]);
    expect(JSON.stringify(result)).not.toContain(Buffer.from(ANTHROPIC_KEY).toString('base64'));
  });

  test('a failed Secret deletes the Job and says nothing secret', async () => {
    const api = fakeApi({
      createSecret: async () => {
        throw Object.assign(new Error(`rejected ${ANTHROPIC_KEY}`), { code: 422, body: { data: UPLOAD_CODE } });
      },
      deleteJob: async () => {
        throw new Error('delete failed too');
      },
    });
    const error = await adapter(api).startRun(startInput()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KubernetesError);
    expect((error as Error).message).toBe('The Debug Job Secret could not be created.');
    expectNoSecretIn(error);
    expect(api.calls).toEqual(['createJob:debug-it', 'createSecret:debug-it', 'deleteJob:debug-it']);
    expect(api.deletes).toEqual([{ name: JOB_NAME, namespace: 'debug-it', propagationPolicy: 'Background' }]);
  });

  test('a failed Job never creates the Secret and is cleaned up', async () => {
    const api = fakeApi({
      createJob: async () => {
        throw Object.assign(new Error('forbidden'), { code: 403 });
      },
    });
    const error = await adapter(api).startRun(startInput()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KubernetesError);
    expect((error as Error).message).toBe('The Debug Job could not be created.');
    expectNoSecretIn(error);
    expect(api.calls).toEqual(['createJob:debug-it', 'deleteJob:debug-it']);
    expect(api.secrets).toEqual([]);
  });

  test('a created Job without uid is deleted and no Secret is made', async () => {
    const api = fakeApi({ createJob: async ({ body }) => body });
    await expect(adapter(api).startRun(startInput())).rejects.toThrow(KubernetesError);
    expect(api.calls).toEqual(['createJob:debug-it', 'deleteJob:debug-it']);
  });

  test.each([
    ['runId', { runId: '../x' }, '1.2.0'],
    ['uppercase runId', { runId: RUN_ID.toUpperCase() }, '1.2.0'],
    ['imageTag', {}, 'latest:evil'],
  ])('a bad %s throws before any API call', async (_name, change, tag) => {
    const api = fakeApi();
    await expect(adapter(api, tag).startRun({ ...startInput(), ...change })).rejects.toThrow(KubernetesError);
    expect(api.calls).toEqual([]);
  });

  test('deleteRun deletes the Job in the background', async () => {
    const api = fakeApi();
    await adapter(api).deleteRun(RUN_ID);
    expect(api.deletes).toEqual([{ name: JOB_NAME, namespace: 'debug-it', propagationPolicy: 'Background' }]);
  });

  test('deleteRun treats a missing Job as success', async () => {
    const api = fakeApi({
      deleteJob: async () => {
        throw Object.assign(new Error('not found'), { code: 404 });
      },
    });
    await expect(adapter(api).deleteRun(RUN_ID)).resolves.toBeUndefined();
  });

  test('deleteRun reports other errors with a fixed message', async () => {
    const api = fakeApi({
      deleteJob: async () => {
        throw Object.assign(new Error('boom'), { code: 500, body: 'server said things' });
      },
    });
    await expect(adapter(api).deleteRun(RUN_ID)).rejects.toThrow('The Debug Job could not be deleted.');
  });

  test('deleteRun refuses a bad run ID before any API call', async () => {
    const api = fakeApi();
    await expect(adapter(api).deleteRun('../x')).rejects.toThrow(KubernetesError);
    expect(api.calls).toEqual([]);
  });
});

describe('runStatus and listRunJobs', () => {
  const LABELS = { ...DEBUG_JOB_LABELS };
  const OTHER_RUN = '7a6b5c4d-3e2f-4a1b-9c8d-ace000000002';

  test('the receiver port is 8080', () => {
    expect(RECEIVER_PORT).toBe(8080);
  });

  test('a missing Job is exists false, without reading pods', async () => {
    const api = fakeApi({
      readJob: async () => {
        throw Object.assign(new Error('not found'), { code: 404 });
      },
    });
    await expect(adapter(api).runStatus(RUN_ID)).resolves.toEqual({
      exists: false,
      failed: false,
      deadlineExceeded: false,
      podIp: null,
      receiverRunning: false,
      podEndedAt: null,
    });
    expect(api.calls).toEqual(['readJob:debug-it']);
  });

  test('a starting pod: IP and a running receiver, selected by the run ID label', async () => {
    const api = fakeApi({
      listPods: async () => ({
        items: [
          {
            status: {
              phase: 'Pending',
              podIP: '10.0.0.12',
              initContainerStatuses: [{ name: 'receiver', state: { running: { startedAt: 'x' } } }],
              containerStatuses: [{ name: 'claude', state: { waiting: {} } }],
            },
          },
        ],
      }),
    });
    await expect(adapter(api).runStatus(RUN_ID)).resolves.toEqual({
      exists: true,
      failed: false,
      deadlineExceeded: false,
      podIp: '10.0.0.12',
      receiverRunning: true,
      podEndedAt: null,
    });
    expect(api.selectors).toEqual([`debug-it/run-id=${RUN_ID}`]);
  });

  test('an ended pod and a deadline failure', async () => {
    const api = fakeApi({
      readJob: async () => ({
        status: { failed: 1, conditions: [{ type: 'Failed', status: 'True', reason: 'DeadlineExceeded' }] },
      }),
      listPods: async () => ({
        items: [
          {
            status: {
              phase: 'Failed',
              containerStatuses: [{ name: 'claude', state: { terminated: { exitCode: 137, finishedAt: '2026-11-05T10:15:01Z' } } }],
            },
          },
        ],
      }),
    });
    const status = await adapter(api).runStatus(RUN_ID);
    expect(status).toMatchObject({ exists: true, failed: true, deadlineExceeded: true, podEndedAt: '2026-11-05T10:15:01.000Z' });
  });

  test.each([
    ['succeeded', { succeeded: 1 }],
    ['a Complete condition', { conditions: [{ type: 'Complete', status: 'True' }] }],
  ])('a Job that %s with no pod listed has ended', async (_name, jobStatus) => {
    const api = fakeApi({ readJob: async () => ({ status: jobStatus }) });
    const a = createKubernetesAdapter({
      namespace: 'debug-it',
      template: template(),
      imageTag: '1.2.0',
      api,
      now: () => new Date('2026-11-05T10:20:00.000Z'),
    });
    expect(await a.runStatus(RUN_ID)).toEqual({
      exists: true,
      failed: false,
      deadlineExceeded: false,
      podIp: null,
      receiverRunning: false,
      podEndedAt: '2026-11-05T10:20:00.000Z',
    });
  });

  test('a pod phase Succeeded with no finish time ends at the adapter clock', async () => {
    const api = fakeApi({ listPods: async () => ({ items: [{ status: { phase: 'Succeeded' } }] }) });
    const a = createKubernetesAdapter({
      namespace: 'debug-it',
      template: template(),
      imageTag: '1.2.0',
      api,
      now: () => new Date('2026-11-05T10:20:00.000Z'),
    });
    expect((await a.runStatus(RUN_ID)).podEndedAt).toBe('2026-11-05T10:20:00.000Z');
  });

  test('read errors are fixed KubernetesError messages', async () => {
    const readFails = fakeApi({
      readJob: async () => {
        throw Object.assign(new Error(`boom ${ANTHROPIC_KEY}`), { code: 500 });
      },
    });
    const error = await adapter(readFails).runStatus(RUN_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KubernetesError);
    expect((error as Error).message).toBe('The Debug Job could not be read.');
    expectNoSecretIn(error);
    const podsFail = fakeApi({
      listPods: async () => {
        throw new Error('boom');
      },
    });
    await expect(adapter(podsFail).runStatus(RUN_ID)).rejects.toThrow('The Debug Job pod could not be read.');
    await expect(adapter(fakeApi()).runStatus('../x')).rejects.toThrow(KubernetesError);
  });

  test('listRunJobs lists run IDs of Debug Jobs only', async () => {
    const api = fakeApi({
      listJobs: async () => ({
        items: [
          { metadata: { labels: { ...LABELS, 'debug-it/run-id': RUN_ID } } },
          { metadata: { labels: { ...LABELS, 'debug-it/run-id': OTHER_RUN } } },
          { metadata: { labels: { ...LABELS, 'debug-it/run-id': RUN_ID } } },
          { metadata: { labels: { ...LABELS } } },
          { metadata: { labels: { 'debug-it/run-id': '../x', ...LABELS } } },
          { metadata: { labels: { 'debug-it/run-id': OTHER_RUN.replace('7a', '8a') } } },
        ],
      }),
    });
    await expect(adapter(api).listRunJobs()).resolves.toEqual([RUN_ID, OTHER_RUN].sort());
    expect(api.selectors).toEqual([runJobSelector()]);
    expect(runJobSelector()).toBe(
      'app.kubernetes.io/name=debug-it-job,app.kubernetes.io/part-of=github-runner-monitor,debug-it/run-id',
    );
  });

  test('listRunJobs reports errors with a fixed message', async () => {
    const api = fakeApi({
      listJobs: async () => {
        throw new Error('boom');
      },
    });
    await expect(adapter(api).listRunJobs()).rejects.toThrow('The Debug Jobs could not be listed.');
  });

  test('the mock adapter answers from its own runs', async () => {
    const mock = createMockKubernetesAdapter();
    await mock.startRun(startInput());
    expect((await mock.runStatus(RUN_ID)).exists).toBe(true);
    await expect(mock.listRunJobs()).resolves.toEqual([RUN_ID]);
    await mock.deleteRun(RUN_ID);
    expect((await mock.runStatus(RUN_ID)).exists).toBe(false);
    await expect(mock.listRunJobs()).resolves.toEqual([]);
  });
});

describe('getKubernetesAdapter', () => {
  afterEach(() => resetKubernetesAdapter());

  test('throws a fixed message when not configured', () => {
    expect(() => getKubernetesAdapter({ DEBUG_IT_NAMESPACE: 'debug-it', DEBUG_JOB_IMAGE_TAG: '1.2.0' })).toThrow(
      'The Debug Job template, image tag or namespace is not configured.',
    );
    expect(() => getKubernetesAdapter({ DEBUG_IT_NAMESPACE: 'debug-it', DEBUG_IT_JOB_TEMPLATE: TEMPLATE_JSON })).toThrow(
      'The Debug Job template, image tag or namespace is not configured.',
    );
  });

  test('throws a fixed message when the namespace is missing', () => {
    expect(() => getKubernetesAdapter({ DEBUG_JOB_IMAGE_TAG: '1.2.0', DEBUG_IT_JOB_TEMPLATE: TEMPLATE_JSON })).toThrow(
      'The Debug Job template, image tag or namespace is not configured.',
    );
  });

  test('refuses a bad template from the environment', () => {
    expect(() =>
      getKubernetesAdapter({ DEBUG_IT_NAMESPACE: 'debug-it', DEBUG_JOB_IMAGE_TAG: '1.2.0', DEBUG_IT_JOB_TEMPLATE: '{}' }),
    ).toThrow(KubernetesError);
  });

  test('builds one adapter from the environment without loading the SDK', () => {
    const env = { DEBUG_IT_NAMESPACE: 'debug-it', DEBUG_JOB_IMAGE_TAG: '1.2.0', DEBUG_IT_JOB_TEMPLATE: TEMPLATE_JSON };
    const first = getKubernetesAdapter(env);
    expect(getKubernetesAdapter(env)).toBe(first);
  });

  test('mock mode records nothing to a cluster', async () => {
    const mock = getKubernetesAdapter({ USE_MOCK_DATA: 'true' });
    await expect(mock.startRun(startInput())).resolves.toEqual({ jobName: JOB_NAME, secretName: JOB_NAME });
    await expect(mock.deleteRun(RUN_ID)).resolves.toBeUndefined();
    await expect(mock.startRun({ ...startInput(), runId: '../x' })).rejects.toThrow(KubernetesError);
  });
});

// --- startup isolation check Job (story 3.6) ---

describe('parseCheckJobTemplate', () => {
  test('accepts the chart template: one container, Debug Job labels, no Secret, no volume', () => {
    const job = parseCheckJobTemplate(CHECK_TEMPLATE_JSON);
    const pod = job.spec.template.spec;
    expect(pod.containers.map((c) => c.name)).toEqual([CHECK_CONTAINER]);
    expect(pod.initContainers).toBeUndefined();
    expect(pod.volumes).toBeUndefined();
    expect(job.metadata.labels).toEqual({ ...DEBUG_JOB_LABELS, 'debug-it/check': 'true' });
    expect(job.spec.template.metadata.labels).toEqual({ ...DEBUG_JOB_LABELS, 'debug-it/check': 'true' });
    expect(job.spec.activeDeadlineSeconds).toBe(120);
    expect(job.spec.backoffLimit).toBe(0);
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.restartPolicy).toBe('Never');
    expect(pod.containers[0]?.command).toEqual(['node', '/app/src/isolationCheck.ts']);
    expect(CHECK_TEMPLATE_JSON).not.toMatch(/secret/i);
  });

  const base = () => JSON.parse(CHECK_TEMPLATE_JSON) as Record<string, any>;
  test.each<[string, (t: Record<string, any>) => unknown]>([
    ['not a Job', (t) => ({ ...t, kind: 'Pod' })],
    ['two containers', (t) => {
      t.spec.template.spec.containers.push({ ...t.spec.template.spec.containers[0], name: 'other' });
      return t;
    }],
    ['a wrong container name', (t) => {
      t.spec.template.spec.containers[0].name = 'claude';
      return t;
    }],
    ['init containers', (t) => {
      t.spec.template.spec.initContainers = [{ name: 'x', image: 'acme/debug-job' }];
      return t;
    }],
    ['volumes', (t) => {
      t.spec.template.spec.volumes = [{ name: 'anthropic-key', secret: { secretName: '' } }];
      return t;
    }],
    ['an image with a tag', (t) => {
      t.spec.template.spec.containers[0].image = 'acme/debug-job:1.0.0';
      return t;
    }],
  ])('refuses %s with a fixed message', (_name, change) => {
    expect(() => parseCheckJobTemplate(JSON.stringify(change(base())))).toThrow(
      /^The isolation check Job template is not valid: /,
    );
  });

  test('refuses text that is not JSON', () => {
    expect(() => parseCheckJobTemplate('{')).toThrow('The isolation check Job template is not valid: it is not JSON.');
  });
});

describe('buildCheckJob', () => {
  test('sets only the name and the image tag, on a copy', () => {
    const template = parseCheckJobTemplate(CHECK_TEMPLATE_JSON);
    const job = buildCheckJob(template, { checkId: '0a1b2c3d', imageTag: '1.2.0' });
    expect(job.metadata.name).toBe('debug-it-check-0a1b2c3d');
    expect(job.spec.template.spec.containers[0]?.image).toBe('acme/debug-job:1.2.0');
    const expected = JSON.parse(CHECK_TEMPLATE_JSON);
    expected.metadata.name = 'debug-it-check-0a1b2c3d';
    expected.spec.template.spec.containers[0].image = 'acme/debug-job:1.2.0';
    expect(job).toEqual(expected);
    expect(template).toEqual(JSON.parse(CHECK_TEMPLATE_JSON));
  });

  test.each(['0A1B2C3D', '0a1b2c3', '../check', ''])('refuses check ID %p', (checkId) => {
    expect(() => buildCheckJob(parseCheckJobTemplate(CHECK_TEMPLATE_JSON), { checkId, imageTag: '1.2.0' })).toThrow(
      'The isolation check ID is not valid.',
    );
  });

  test('refuses a bad image tag', () => {
    expect(() => buildCheckJob(parseCheckJobTemplate(CHECK_TEMPLATE_JSON), { checkId: '0a1b2c3d', imageTag: 'a b' })).toThrow(
      KubernetesError,
    );
  });
});

interface FakeCheckApi extends CheckJobApi {
  calls: string[];
  created: Job[];
  deletes: Array<{ name: string; namespace: string; propagationPolicy: string }>;
  selectors: string[];
}

/** A fake cluster with a fake clock: each sleep advances it. */
function fakeCheck(options: {
  states?: Array<JobState | Error>;
  pods?: { items: PodState[] } | Error;
  createFails?: boolean;
  deleteFails?: boolean;
} = {}) {
  let clock = 1_000_000;
  const states = [...(options.states ?? [])];
  const api: FakeCheckApi = {
    calls: [],
    created: [],
    deletes: [],
    selectors: [],
    async createJob({ namespace, body }) {
      api.calls.push(`createJob:${namespace}`);
      api.created.push(body);
      if (options.createFails) throw Object.assign(new Error('forbidden'), { code: 403 });
      return body;
    },
    async readJob({ name, namespace }) {
      api.calls.push(`readJob:${namespace}:${name}`);
      const next = states.length > 1 ? states.shift() : states[0];
      if (next instanceof Error) throw next;
      return next ?? {};
    },
    async listPods({ namespace, labelSelector }) {
      api.calls.push(`listPods:${namespace}`);
      api.selectors.push(labelSelector);
      if (options.pods instanceof Error) throw options.pods;
      return options.pods ?? { items: [] };
    },
    async deleteJob(params) {
      api.calls.push(`deleteJob:${params.namespace}:${params.name}`);
      api.deletes.push(params);
      if (options.deleteFails) throw Object.assign(new Error('gone'), { code: 500 });
      return {};
    },
  };
  const sleeps: number[] = [];
  const checkRunner = createIsolationCheckRunner({
    namespace: 'debug-it',
    template: parseCheckJobTemplate(CHECK_TEMPLATE_JSON),
    imageTag: '1.2.0',
    api,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  });
  return { api, checkRunner, sleeps };
}

function podExit(exitCode: number): { items: PodState[] } {
  return {
    items: [
      {
        status: {
          containerStatuses: [{ name: 'isolation-check', state: { terminated: { exitCode, reason: 'Error' } } }],
        },
      },
    ],
  };
}

describe('createIsolationCheckRunner', () => {
  test('passed: creates the check Job, polls until it succeeds, then deletes it', async () => {
    const { api, checkRunner, sleeps } = fakeCheck({ states: [{}, { status: {} }, { status: { succeeded: 1 } }] });
    await expect(checkRunner.run()).resolves.toEqual({ status: 'passed' });
    const job = api.created[0]!;
    expect(job.metadata.name).toMatch(/^debug-it-check-[0-9a-f]{8}$/);
    expect(job.spec.template.spec.containers[0]?.image).toBe('acme/debug-job:1.2.0');
    expect(job.spec.template.metadata.labels).toEqual({ ...DEBUG_JOB_LABELS, 'debug-it/check': 'true' });
    const name = job.metadata.name!;
    expect(api.calls).toEqual([
      'createJob:debug-it',
      `readJob:debug-it:${name}`,
      `readJob:debug-it:${name}`,
      `readJob:debug-it:${name}`,
      `deleteJob:debug-it:${name}`,
    ]);
    expect(sleeps).toEqual([2000, 2000]);
    expect(api.deletes).toEqual([{ name, namespace: 'debug-it', propagationPolicy: 'Background' }]);
  });

  test('each run uses a new check ID', async () => {
    const { api, checkRunner } = fakeCheck({ states: [{ status: { succeeded: 1 } }] });
    await checkRunner.run();
    await checkRunner.run();
    expect(api.created[0]!.metadata.name).not.toBe(api.created[1]!.metadata.name);
  });

  test.each([3, 4, 5, 1])('failed: reads exit code %i from the pod', async (exitCode) => {
    const { api, checkRunner } = fakeCheck({ states: [{ status: { failed: 1 } }], pods: podExit(exitCode) });
    await expect(checkRunner.run()).resolves.toEqual({ status: 'failed', exitCode });
    const name = api.created[0]!.metadata.name!;
    expect(api.selectors).toEqual([`job-name=${name}`]);
    expect(api.deletes).toHaveLength(1);
  });

  test('failed: an unreadable pod list gives a null exit code', async () => {
    const { api, checkRunner } = fakeCheck({ states: [{ status: { failed: 1 } }], pods: new Error('no access') });
    await expect(checkRunner.run()).resolves.toEqual({ status: 'failed', exitCode: null });
    expect(api.deletes).toHaveLength(1);
  });

  test('failed: a pod without a terminated check container gives a null exit code', async () => {
    const { checkRunner } = fakeCheck({
      states: [{ status: { failed: 1 } }],
      pods: { items: [{ status: { containerStatuses: [{ name: 'other', state: { terminated: { exitCode: 3 } } }] } }, {}] },
    });
    await expect(checkRunner.run()).resolves.toEqual({ status: 'failed', exitCode: null });
  });

  test('timeout: stops after 2 minutes and deletes the Job, even when the delete fails', async () => {
    const { api, checkRunner, sleeps } = fakeCheck({ states: [{ status: { active: 1 } }], deleteFails: true });
    await expect(checkRunner.run()).resolves.toEqual({ status: 'timeout' });
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(120_000);
    expect(sleeps).toHaveLength(60);
    expect(api.deletes).toHaveLength(1);
  });

  test('read errors are retried until the timeout', async () => {
    const { checkRunner } = fakeCheck({ states: [new Error('unavailable'), { status: { succeeded: 1 } }] });
    await expect(checkRunner.run()).resolves.toEqual({ status: 'passed' });
  });

  test('a failed create: not started, and the Job is still deleted', async () => {
    const { api, checkRunner } = fakeCheck({ createFails: true });
    await expect(checkRunner.run()).resolves.toEqual({ status: 'not-started' });
    expect(api.calls.filter((c) => c.startsWith('readJob'))).toEqual([]);
    expect(api.deletes).toHaveLength(1);
  });
});

describe('createIsolationCheckRunner with a call that never settles', () => {
  const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

  function hungRunner(hang: keyof CheckJobApi, timeoutMs = 100) {
    const deletes: string[] = [];
    const api: CheckJobApi = {
      createJob: async ({ body }) => body,
      readJob: async () => ({ status: { failed: 1 } }),
      listPods: async () => podExit(3),
      deleteJob: async ({ name }) => {
        deletes.push(name);
        return {};
      },
    };
    (api as unknown as Record<string, unknown>)[hang] = (...args: unknown[]) => {
      if (hang === 'deleteJob') deletes.push((args[0] as { name: string }).name);
      return never();
    };
    const checkRunner = createIsolationCheckRunner({
      namespace: 'debug-it',
      template: parseCheckJobTemplate(CHECK_TEMPLATE_JSON),
      imageTag: '1.2.0',
      api,
      timeoutMs,
      pollMs: 20,
    });
    return { checkRunner, deletes };
  }

  test.each<[keyof CheckJobApi, unknown]>([
    ['createJob', { status: 'not-started' }],
    ['readJob', { status: 'timeout' }],
    ['listPods', { status: 'failed', exitCode: null }],
  ])('a hung %s still ends the run and deletes the Job', async (hang, outcome) => {
    const { checkRunner, deletes } = hungRunner(hang);
    const started = Date.now();
    await expect(checkRunner.run()).resolves.toEqual(outcome);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(deletes).toHaveLength(1);
  });

  test('a hung delete is given up after 10 seconds', async () => {
    jest.useFakeTimers();
    try {
      const { checkRunner, deletes } = hungRunner('deleteJob', 120_000);
      let outcome: unknown;
      const pending = checkRunner.run().then((value) => (outcome = value));
      await jest.advanceTimersByTimeAsync(9_000);
      expect(outcome).toBeUndefined();
      await jest.advanceTimersByTimeAsync(1_000);
      await pending;
      expect(outcome).toEqual({ status: 'failed', exitCode: 3 });
      expect(deletes).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('getIsolationCheckRunner', () => {
  afterEach(() => resetIsolationCheckRunner());

  test('throws a fixed message when not configured', () => {
    for (const env of [
      { DEBUG_IT_NAMESPACE: 'debug-it', DEBUG_JOB_IMAGE_TAG: '1.2.0' },
      { DEBUG_IT_NAMESPACE: 'debug-it', DEBUG_IT_CHECK_JOB_TEMPLATE: CHECK_TEMPLATE_JSON },
      { DEBUG_JOB_IMAGE_TAG: '1.2.0', DEBUG_IT_CHECK_JOB_TEMPLATE: CHECK_TEMPLATE_JSON },
    ]) {
      expect(() => getIsolationCheckRunner(env)).toThrow(
        'The isolation check Job template, image tag or namespace is not configured.',
      );
    }
  });

  test('refuses a bad template from the environment', () => {
    expect(() =>
      getIsolationCheckRunner({ DEBUG_IT_NAMESPACE: 'debug-it', DEBUG_JOB_IMAGE_TAG: '1.2.0', DEBUG_IT_CHECK_JOB_TEMPLATE: TEMPLATE_JSON }),
    ).toThrow(KubernetesError);
  });

  test('builds one runner from the environment without loading the SDK', () => {
    const env = { DEBUG_IT_NAMESPACE: 'debug-it', DEBUG_JOB_IMAGE_TAG: '1.2.0', DEBUG_IT_CHECK_JOB_TEMPLATE: CHECK_TEMPLATE_JSON };
    expect(getIsolationCheckRunner(env)).toBe(getIsolationCheckRunner(env));
  });

  test('mock mode always passes', async () => {
    await expect(getIsolationCheckRunner({ USE_MOCK_DATA: 'true' }).run()).resolves.toEqual({ status: 'passed' });
  });
});
