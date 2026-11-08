// Fetches a run's inputs (story 3.8, FR43, AD-17): the failed job's log (or,
// for a run without jobs, its workflow file), the failing repository at the
// failed commit and each allowed, readable extra repository at its default
// branch. Everything is streamed to the run's Debug Job receiver; no GitHub
// credential or address leaves the backend. Each download is recorded on the
// run record before its upload starts. The step writes only `downloads`,
// `skippedRepositories` and `logTruncated`: the lifecycle (story 3.10) moves
// the state, gives the count back on failure and finds the receiver.
import { Transform, type Readable, type TransformCallback } from 'stream';
import { GitHubAppError, type GitHubApp, type RepositoryPermission } from '../../adapters/githubApp.ts';
import type { S3Store } from '../../adapters/s3Store.ts';
import { loadContextFile } from './contextFile.ts';
import { isRunId, runKey, type RunDownload, type RunRecord } from './runs.ts';
import type { DebugItSettings, SettingsService } from './settings.ts';
import { createHttpUploader, UploadError, type Uploader, type UploadTarget } from './upload.ts';

/** The most code one run downloads, summed across its repositories (500 MiB). */
export const DEFAULT_DOWNLOAD_LIMIT_BYTES = 524288000;

export type SkippedRepositoryReason =
  | 'invalid-name'
  | 'outside-organization'
  | 'over-limit'
  | 'not-allowed'
  | 'no-read-access';

export interface SkippedRepository {
  repository: string;
  reason: string;
}

export type DownloadOutcome =
  | { ok: true; downloads: RunDownload[]; skippedRepositories: SkippedRepository[]; logTruncated: boolean }
  | { ok: false; reason: string };

/** Every reason the step can fail with: fixed sentences, never GitHub text. */
export const DOWNLOAD_ERRORS = {
  runNotFound: 'This debug run was not found.',
  notCloning: 'This debug run is no longer fetching its log and code.',
  s3: 'S3 could not be reached while the log and code of this run were being fetched.',
  log: 'GitHub could not give the log of the failed job.',
  workflowFile: 'GitHub could not give the workflow file of the failed run.',
  contextFile: 'The debug context file of this repository could not be read again.',
  settings: 'Debug it settings could not be read while the extra repositories were being checked.',
  noCommit: 'The failed commit of this run is not known, so its code cannot be downloaded.',
  download: 'GitHub could not give the code of a repository for this run.',
  tooLarge: (limitBytes: number): string =>
    `The code to download for this run is larger than the ${Math.floor(limitBytes / 1048576)} MiB limit.`,
  upload: 'The Debug Job did not accept the log and code of this run.',
  unexpected: 'An unexpected error stopped fetching the log and code of this run.',
} as const;

export interface DownloadStepOptions {
  store: Pick<S3Store, 'read' | 'modify'>;
  githubApp: Pick<GitHubApp, 'readLog' | 'readWorkflowRun' | 'readContextFile' | 'checkPermission' | 'downloadTarball'>;
  settings: Pick<SettingsService, 'load' | 'isRepositoryAllowed'>;
  organization: string;
  logLimitBytes: number;
  /** Summed across every repository of a run; defaults to 500 MB. */
  downloadLimitBytes?: number;
  uploader?: Uploader;
}

export interface DownloadStep {
  /** Fetches the log and code of run `runId` (in state cloning) into the receiver at `target`. */
  fetchRunInputs(runId: string, target: UploadTarget): Promise<DownloadOutcome>;
}

// A failure with a fixed reason and a fixed cause for the log line.
class StepFailure extends Error {
  constructor(
    readonly reason: string,
    readonly cause_: string,
  ) {
    super(reason);
  }
}

const COMMIT_SHA = /^[0-9a-f]{40}$/i;

function repositoryName(repository: string): string {
  return repository.split('/')[1] ?? '';
}

export function createDownloadStep(options: DownloadStepOptions): DownloadStep {
  const { store, githubApp, settings, organization, logLimitBytes } = options;
  const downloadLimit = options.downloadLimitBytes ?? DEFAULT_DOWNLOAD_LIMIT_BYTES;
  const uploader = options.uploader ?? createHttpUploader();

  // Applies `change` to the run record only while it is in cloning.
  async function modifyWhileCloning(runId: string, change: (record: RunRecord) => RunRecord): Promise<void> {
    let outcome: 'written' | 'missing' | 'state' = 'missing';
    try {
      await store.modify<RunRecord>(runKey(runId), (current) => {
        if (!current) {
          outcome = 'missing';
          return undefined;
        }
        if (current.state !== 'cloning') {
          outcome = 'state';
          return undefined;
        }
        outcome = 'written';
        return change(current);
      });
    } catch {
      throw new StepFailure(DOWNLOAD_ERRORS.s3, 'the run record could not be written');
    }
    if (outcome === 'missing') throw new StepFailure(DOWNLOAD_ERRORS.runNotFound, 'the run record is gone');
    if (outcome === 'state') throw new StepFailure(DOWNLOAD_ERRORS.notCloning, 'the run left cloning');
  }

  async function readRecord(runId: string): Promise<RunRecord> {
    let stored;
    try {
      stored = await store.read<RunRecord>(runKey(runId));
    } catch {
      throw new StepFailure(DOWNLOAD_ERRORS.s3, 'the run record could not be read');
    }
    if (!stored || !stored.value || typeof stored.value !== 'object') {
      throw new StepFailure(DOWNLOAD_ERRORS.runNotFound, 'the run record is missing');
    }
    const record = stored.value;
    if (record.state !== 'cloning') throw new StepFailure(DOWNLOAD_ERRORS.notCloning, 'the run is not in cloning');
    if (typeof record.repository !== 'string' || !record.target || !Array.isArray(record.downloads)) {
      throw new StepFailure(DOWNLOAD_ERRORS.s3, 'the run record is malformed');
    }
    return record;
  }

  async function readInputLog(record: RunRecord): Promise<{ text: Buffer; truncated: boolean }> {
    if (record.target.kind === 'job') {
      try {
        return await githubApp.readLog(record.repository, record.target.id, logLimitBytes);
      } catch {
        throw new StepFailure(DOWNLOAD_ERRORS.log, 'the job log could not be read');
      }
    }
    let info;
    try {
      info = await githubApp.readWorkflowRun(record.repository, record.target.id, { workflowFile: true });
    } catch {
      throw new StepFailure(DOWNLOAD_ERRORS.workflowFile, 'the workflow run could not be read');
    }
    if (!info.workflowFile) throw new StepFailure(DOWNLOAD_ERRORS.workflowFile, 'the workflow file could not be read');
    // The header and error message are kept whole; only the file text is cut to fit.
    const header = Buffer.from(`Workflow file: ${info.workflowFile.path}\n\n`, 'utf8');
    const message = info.errorMessage ? Buffer.from(`\n\nGitHub's error message:\n${info.errorMessage}`, 'utf8') : Buffer.alloc(0);
    const file = Buffer.from(info.workflowFile.text, 'utf8');
    const room = Math.max(0, logLimitBytes - header.length - message.length);
    const truncated = file.length > room;
    const kept = truncated ? file.subarray(file.length - room) : file;
    return { text: Buffer.concat([header, kept, message]), truncated };
  }

  async function pickExtras(record: RunRecord): Promise<{ kept: string[]; skipped: SkippedRepository[] }> {
    let context;
    try {
      context = await loadContextFile(githubApp, record.repository, organization);
    } catch {
      throw new StepFailure(DOWNLOAD_ERRORS.contextFile, 'the debug context file could not be read');
    }
    if (!context.ok) throw new StepFailure(DOWNLOAD_ERRORS.contextFile, 'the debug context file is no longer usable');
    const skipped: SkippedRepository[] = context.context.skippedRepositories.map((s) => ({
      repository: s.entry,
      reason: s.reason,
    }));
    if (context.context.extraRepositories.length === 0) return { kept: [], skipped };
    let current: DebugItSettings;
    try {
      current = await settings.load();
    } catch {
      throw new StepFailure(DOWNLOAD_ERRORS.settings, 'the settings could not be read');
    }
    const kept: string[] = [];
    for (const repository of context.context.extraRepositories) {
      if (!settings.isRepositoryAllowed(current, repository)) {
        skipped.push({ repository, reason: 'not-allowed' });
        continue;
      }
      let level: RepositoryPermission;
      try {
        level = await githubApp.checkPermission(record.requester, repository, { fresh: true });
      } catch {
        // Fail closed: an unanswered check is no access.
        level = 'none';
      }
      if (level !== 'read' && level !== 'write') {
        skipped.push({ repository, reason: 'no-read-access' });
        continue;
      }
      kept.push(repository);
    }
    return { kept, skipped };
  }

  async function run(runId: string, target: UploadTarget): Promise<DownloadOutcome> {
    // 1. The run must exist and be in cloning.
    const record = await readRecord(runId);
    if (typeof record.headSha !== 'string' || !COMMIT_SHA.test(record.headSha)) {
      throw new StepFailure(DOWNLOAD_ERRORS.noCommit, 'the failed commit is not known');
    }

    // 2. The log, or the workflow file for a run without jobs.
    const log = await readInputLog(record);

    // 3. The extra repositories, checked again now.
    const { kept, skipped } = await pickExtras(record);

    // 4. Upload the log, then each repository.
    try {
      await uploader.putLog(target, log.text);
    } catch {
      throw new StepFailure(DOWNLOAD_ERRORS.upload, 'the receiver refused the log');
    }

    const downloads: RunDownload[] = [];
    let total = 0;
    const repositories: Array<{ repository: string; ref: string | null }> = [
      { repository: record.repository, ref: record.headSha },
      ...kept.map((repository) => ({ repository, ref: null })),
    ];
    for (const { repository, ref } of repositories) {
      let tarball: { commitSha: string; body: Readable };
      try {
        tarball = await githubApp.downloadTarball(repository, ref);
      } catch (error) {
        const what = error instanceof GitHubAppError ? 'GitHub refused a repository download' : 'a repository download failed';
        throw new StepFailure(DOWNLOAD_ERRORS.download, what);
      }
      // A reset or abort before the upload starts must not be an unhandled 'error'.
      let bodyError: Error | null = null;
      tarball.body.on('error', (error: Error) => {
        bodyError = error;
      });
      const download: RunDownload = { repository, commitSha: tarball.commitSha, folder: repositoryName(repository) };
      try {
        // Recorded before the upload starts, so a viewer's access check covers it.
        await modifyWhileCloning(runId, (current) => ({ ...current, downloads: [...current.downloads, download] }));
      } catch (error) {
        tarball.body.destroy();
        throw error;
      }
      downloads.push(download);

      let overLimit = false;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
          total += chunk.length;
          if (total > downloadLimit) {
            overLimit = true;
            callback(new Error('over the download limit'));
            return;
          }
          callback(null, chunk);
        },
      });
      if (bodyError || tarball.body.destroyed) {
        throw new StepFailure(DOWNLOAD_ERRORS.download, 'a repository download broke off');
      }
      tarball.body.once('error', (error: Error) => counter.destroy(error));
      counter.once('error', () => tarball.body.destroy());
      tarball.body.pipe(counter);
      try {
        await uploader.putRepo(target, download.folder, counter);
      } catch (error) {
        if (overLimit) throw new StepFailure(DOWNLOAD_ERRORS.tooLarge(downloadLimit), 'the code is over the size limit');
        if (error instanceof UploadError) throw new StepFailure(DOWNLOAD_ERRORS.upload, 'the receiver refused a repository');
        throw new StepFailure(DOWNLOAD_ERRORS.download, 'a repository download broke off');
      } finally {
        tarball.body.destroy();
        counter.destroy();
      }
    }

    // 5. What was skipped and whether the log was cut, then the manifest.
    await modifyWhileCloning(runId, (current) => ({
      ...current,
      skippedRepositories: skipped.map((s) => ({ ...s })),
      logTruncated: log.truncated,
    }));
    try {
      await uploader.done(target, { folders: downloads.map((d) => d.folder), logTruncated: log.truncated });
    } catch {
      throw new StepFailure(DOWNLOAD_ERRORS.upload, 'the receiver refused the manifest');
    }

    console.log(
      `[INFO] Debug it run ${runId} fetched its inputs: ${downloads.length} repositories downloaded, ${skipped.length} skipped, log ${log.truncated ? 'cut to its last part' : 'whole'}`,
    );
    return { ok: true, downloads, skippedRepositories: skipped, logTruncated: log.truncated };
  }

  return {
    async fetchRunInputs(runId, target) {
      if (!isRunId(runId)) return { ok: false, reason: DOWNLOAD_ERRORS.runNotFound };
      try {
        return await run(runId, target);
      } catch (error) {
        const failure =
          error instanceof StepFailure ? error : new StepFailure(DOWNLOAD_ERRORS.unexpected, 'an unexpected error stopped it');
        console.error(`[ERROR] Debug it run ${runId} could not fetch its log and code: ${failure.cause_}`);
        return { ok: false, reason: failure.reason };
      }
    },
  };
}
