import { currentRevision, markRestoreFailed, restore, serialize } from './jobStore.ts';

const BUCKET = process.env.JOB_STATE_S3_BUCKET;
const KEY = process.env.JOB_STATE_S3_KEY || 'github-runner-monitor/job-store.json';
const REGION = process.env.AWS_REGION || 'us-east-2';

const SAVE_INTERVAL_MS = parseFloat(process.env.JOB_STATE_SAVE_INTERVAL_SECONDS || '60') * 1000;

let client: any;

async function s3(): Promise<{ client: any; commands: any }> {
  const sdk = await import('@aws-sdk/client-s3');
  client ??= new sdk.S3Client({ region: REGION });
  return { client, commands: sdk };
}

export function persistenceEnabled(): boolean {
  return Boolean(BUCKET) && process.env.USE_MOCK_DATA !== 'true';
}

export async function loadState(): Promise<void> {
  if (!persistenceEnabled()) {
    markRestoreFailed();
    return;
  }

  try {
    const { client: s3Client, commands } = await s3();
    const response = await s3Client.send(new commands.GetObjectCommand({ Bucket: BUCKET, Key: KEY }));
    const body = await response.Body?.transformToString();
    if (!body) {
      markRestoreFailed();
      console.warn('[WARN] The saved job store was empty — starting cold');
      return;
    }

    const accepted = restore(JSON.parse(body));
    console.log(`[AUDIT] Restored ${accepted} jobs from s3://${BUCKET}/${KEY}`);
  } catch (error: any) {
    markRestoreFailed();
    if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) {
      console.log('[AUDIT] No saved job store yet — starting cold, which is expected on a first deploy');
      return;
    }
    console.error(`[ERROR] Could not read the saved job store: ${error?.message ?? error}`);
  }
}

let savedRevision = -1;
let saveInFlight = false;

export async function saveState(force = false): Promise<void> {
  if (!persistenceEnabled()) return;
  if (saveInFlight) return;

  const revision = currentRevision();
  if (!force && revision === savedRevision) return;

  saveInFlight = true;
  try {
    const { client: s3Client, commands } = await s3();
    await s3Client.send(
      new commands.PutObjectCommand({
        Bucket: BUCKET,
        Key: KEY,
        Body: JSON.stringify(serialize()),
        ContentType: 'application/json',
      })
    );
    savedRevision = revision;
  } catch (error: any) {
    console.error(`[ERROR] Could not save the job store: ${error?.message ?? error}`);
  } finally {
    saveInFlight = false;
  }
}

let timer: NodeJS.Timeout | null = null;

export function startPeriodicSave(): void {
  if (!persistenceEnabled() || timer) return;
  timer = setInterval(() => void saveState(), SAVE_INTERVAL_MS);
  timer.unref?.();
  console.log(`[AUDIT] Saving the job store to s3://${BUCKET}/${KEY} every ${SAVE_INTERVAL_MS}ms`);
}

export function stopPeriodicSave(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export async function readJsonObject(key: string): Promise<unknown | null> {
  if (!persistenceEnabled()) return null;
  try {
    const { client: s3Client, commands } = await s3();
    const response = await s3Client.send(new commands.GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const body = await response.Body?.transformToString();
    return body ? JSON.parse(body) : null;
  } catch (error: any) {
    if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}

export async function writeJsonObject(key: string, value: unknown): Promise<void> {
  if (!persistenceEnabled()) return;
  const { client: s3Client, commands } = await s3();
  await s3Client.send(
    new commands.PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: JSON.stringify(value),
      ContentType: 'application/json',
    })
  );
}

export function describeLocation(key: string): string {
  return `s3://${BUCKET}/${key}`;
}
