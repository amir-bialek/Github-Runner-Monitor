import axios, { AxiosResponse } from 'axios';
import { LRUCache } from 'lru-cache';
import { GitHubWorkflowRun, GitHubWorkflowRunsResponse, WorkflowRunsOptions, GitHubJob, GitHubJobsResponse, GitHubRepo, GitHubRunner, GitHubRunnersResponse, GitHubAPIErrorType, APIError, CircuitBreakerState } from '../types/github';

const GITHUB_BASE_URL = 'https://api.github.com';

const MAX_RETRIES = parseInt(process.env.GITHUB_MAX_RETRIES || '3');
const BASE_DELAY_MS = parseFloat(process.env.GITHUB_BASE_DELAY_SECONDS || '1') * 1000;
const MAX_DELAY_MS = parseFloat(process.env.GITHUB_MAX_DELAY_SECONDS || '10') * 1000;
const MAX_RETRY_WAIT_MS = parseFloat(process.env.GITHUB_MAX_RETRY_WAIT_SECONDS || '10') * 1000;

const RUNNERS_PER_PAGE = 100;
const MAX_RUNNER_PAGES = parseInt(process.env.GITHUB_MAX_RUNNER_PAGES || '20');

const JOBS_PER_PAGE = 100;
const MAX_JOB_PAGES = parseInt(process.env.GITHUB_MAX_JOB_PAGES || '10');

const ETAG_CACHE_SIZE = parseInt(process.env.GITHUB_ETAG_CACHE_SIZE || '500');

const RATE_LIMIT_RESERVE = parseInt(process.env.GITHUB_RATE_LIMIT_RESERVE || '50');

const CIRCUIT_BREAKER_FAILURE_THRESHOLD = parseInt(process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD || '5');
const CIRCUIT_BREAKER_TIMEOUT_MS = parseFloat(process.env.CIRCUIT_BREAKER_TIMEOUT_SECONDS || '60') * 1000;
const CIRCUIT_BREAKER_HALF_OPEN_MAX_CALLS = parseInt(process.env.CIRCUIT_BREAKER_HALF_OPEN_MAX_CALLS || '3');

export class GitHubApiError extends Error implements APIError {
  readonly type: GitHubAPIErrorType;
  readonly endpoint: string;
  readonly timestamp: Date;
  readonly statusCode?: number | undefined;
  readonly retryAfter?: number | undefined;
  readonly rateLimitRemaining?: number | undefined;
  readonly rateLimitReset?: Date | undefined;

  constructor(fields: APIError) {
    super(fields.message);
    this.name = 'GitHubApiError';
    this.type = fields.type;
    this.endpoint = fields.endpoint;
    this.timestamp = fields.timestamp;
    this.statusCode = fields.statusCode;
    this.retryAfter = fields.retryAfter;
    this.rateLimitRemaining = fields.rateLimitRemaining;
    this.rateLimitReset = fields.rateLimitReset;
  }
}

export function wrapWithContext(error: unknown, context: string): Error {
  if (error instanceof GitHubApiError) {
    return new GitHubApiError({
      type: error.type,
      message: `${context}: ${error.message}`,
      statusCode: error.statusCode,
      retryAfter: error.retryAfter,
      endpoint: error.endpoint,
      timestamp: error.timestamp,
      rateLimitRemaining: error.rateLimitRemaining,
      rateLimitReset: error.rateLimitReset,
    });
  }

  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${context}: ${message}`);
}

export function hasNextPage(response: Pick<AxiosResponse, 'headers'>): boolean {
  const link = (response.headers as Record<string, unknown> | undefined)?.['link'];
  if (typeof link !== 'string') return false;
  return /;\s*rel="next"/.test(link);
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];

  const poolSize = Math.min(Math.max(Math.floor(limit) || 1, 1), items.length);

  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const pool = Array.from({ length: poolSize }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  });

  await Promise.all(pool);
  return results;
}

export interface ConditionalResponse<T> {
  data: T;
  notModified: boolean;
  capped: boolean;
}

interface EtagEntry {
  etag: string;
  data: unknown;
}

const etagStore = new LRUCache<string, EtagEntry>({ max: ETAG_CACHE_SIZE });

export function clearEtagStore(): void {
  etagStore.clear();
}

class CircuitBreaker {
  private state: CircuitBreakerState;
  private readonly failureThreshold: number;
  private readonly timeoutMs: number;
  private readonly halfOpenMaxCalls: number;
  private halfOpenCalls: number = 0;

  constructor(
    failureThreshold: number = CIRCUIT_BREAKER_FAILURE_THRESHOLD,
    timeoutMs: number = CIRCUIT_BREAKER_TIMEOUT_MS,
    halfOpenMaxCalls: number = CIRCUIT_BREAKER_HALF_OPEN_MAX_CALLS
  ) {
    this.failureThreshold = failureThreshold;
    this.timeoutMs = timeoutMs;
    this.halfOpenMaxCalls = halfOpenMaxCalls;
    this.state = {
      failures: 0,
      lastFailure: null,
      state: 'CLOSED',
      nextAttempt: null
    };
  }

  async execute<T>(operation: () => Promise<T>, endpoint: string): Promise<T> {
    if (this.state.state === 'OPEN') {
      if (this.shouldAttemptReset()) {
        this.state.state = 'HALF_OPEN';
        this.halfOpenCalls = 0;
        console.log(`[CIRCUIT_BREAKER] Moving to HALF_OPEN state for endpoint pattern`);
      } else {
        const timeUntilReset = this.state.nextAttempt ? this.state.nextAttempt.getTime() - Date.now() : 0;
        throw new Error(`Circuit breaker is OPEN. Next attempt in ${Math.ceil(timeUntilReset / 1000)} seconds.`);
      }
    }

    if (this.state.state === 'HALF_OPEN') {
      if (this.halfOpenCalls >= this.halfOpenMaxCalls) {
        throw new Error('Circuit breaker is HALF_OPEN and max calls exceeded');
      }
      this.halfOpenCalls++;
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private shouldAttemptReset(): boolean {
    if (this.state.nextAttempt === null) {
      return false;
    }
    return Date.now() >= this.state.nextAttempt.getTime();
  }

  private onSuccess(): void {
    this.state.failures = 0;
    this.state.lastFailure = null;
    this.state.nextAttempt = null;
    
    if (this.state.state === 'HALF_OPEN') {
      this.state.state = 'CLOSED';
      console.log(`[CIRCUIT_BREAKER] Moving to CLOSED state after successful recovery`);
    }
  }

  private onFailure(): void {
    this.state.failures++;
    this.state.lastFailure = new Date();

    if (this.state.state === 'HALF_OPEN') {
      this.state.state = 'OPEN';
      this.state.nextAttempt = new Date(Date.now() + this.timeoutMs);
      console.log(`[CIRCUIT_BREAKER] Moving to OPEN state after HALF_OPEN failure`);
    } else if (this.state.failures >= this.failureThreshold) {
      this.state.state = 'OPEN';
      this.state.nextAttempt = new Date(Date.now() + this.timeoutMs);
      console.log(`[CIRCUIT_BREAKER] Moving to OPEN state after ${this.state.failures} failures`);
    }


  }

  getState(): CircuitBreakerState {
    return { ...this.state };
  }
}

export class GitHubClient {
  private token: string;
  private circuitBreaker: CircuitBreaker;
  private rateLimitRemaining: number = 5000;
  private rateLimitReset: Date | null = null;

  constructor(token: string) {
    this.token = token;
    this.circuitBreaker = new CircuitBreaker();
  }

  private classifyError(error: any, endpoint: string): GitHubApiError {
    return new GitHubApiError(this.classifyErrorFields(error, endpoint));
  }

  private classifyErrorFields(error: any, endpoint: string): APIError {
    const timestamp = new Date();
    
    if (error.response?.status === 401) {
      return {
        type: GitHubAPIErrorType.AUTHENTICATION,
        message: 'Invalid GitHub token - please check your credentials',
        statusCode: 401,
        endpoint,
        timestamp
      };
    } else if (error.response?.status === 403) {
      const rateLimitRemaining = parseInt(error.response?.headers?.['x-ratelimit-remaining'] || '0');
      const rateLimitResetHeader = error.response?.headers?.['x-ratelimit-reset'];
      const rateLimitReset = rateLimitResetHeader 
        ? new Date(parseInt(rateLimitResetHeader) * 1000)
        : undefined;
      
      const retryAfter = rateLimitReset ? Math.ceil((rateLimitReset.getTime() - Date.now()) / 1000) : undefined;
      
      const apiError: APIError = {
        type: GitHubAPIErrorType.RATE_LIMIT,
        message: `GitHub API rate limit exceeded. ${rateLimitRemaining} requests remaining.`,
        statusCode: 403,
        endpoint,
        timestamp,
        rateLimitRemaining
      };
      
      if (rateLimitReset) {
        apiError.rateLimitReset = rateLimitReset;
      }
      
      if (retryAfter) {
        apiError.retryAfter = retryAfter;
      }
      
      return apiError;
    } else if (error.response?.status === 404) {
      return {
        type: GitHubAPIErrorType.NOT_FOUND,
        message: `GitHub API resource not found: ${endpoint}`,
        statusCode: 404,
        endpoint,
        timestamp
      };
    } else if (error.response?.status >= 500) {
      return {
        type: GitHubAPIErrorType.SERVER_ERROR,
        message: `GitHub API server error (${error.response.status}): ${error.message || 'Unknown server error'}`,
        statusCode: error.response.status,
        endpoint,
        timestamp,
        retryAfter: 30
      };
    } else if (error.code === 'ECONNABORTED') {
      return {
        type: GitHubAPIErrorType.TIMEOUT,
        message: `GitHub API request timed out after ${error.config?.timeout || 15000}ms`,
        endpoint,
        timestamp,
        retryAfter: 10
      };
    } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      return {
        type: GitHubAPIErrorType.NETWORK_ERROR,
        message: 'Unable to connect to GitHub API - network connectivity issue',
        endpoint,
        timestamp,
        retryAfter: 30
      };
    } else {
      return {
        type: GitHubAPIErrorType.UNKNOWN,
        message: `GitHub API request failed: ${error.message || 'Unknown error'}`,
        statusCode: error.response?.status,
        endpoint,
        timestamp,
        retryAfter: 10
      };
    }
  }

  private shouldRetry(apiError: APIError, attempt: number): boolean {
    if (apiError.type === GitHubAPIErrorType.AUTHENTICATION || 
        apiError.type === GitHubAPIErrorType.NOT_FOUND) {
      return false;
    }

    if (apiError.type === GitHubAPIErrorType.RATE_LIMIT) {
      return apiError.retryAfter !== undefined && apiError.retryAfter * 1000 <= MAX_RETRY_WAIT_MS;
    }

    return attempt < MAX_RETRIES;
  }

  private calculateBackoffDelay(attempt: number, apiError?: APIError): number {
    if (apiError?.type === GitHubAPIErrorType.RATE_LIMIT && apiError.retryAfter) {
      return Math.min(apiError.retryAfter * 1000, MAX_RETRY_WAIT_MS);
    }

    const baseDelay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
    const jitter = Math.random() * 0.1 * baseDelay;
    return Math.min(baseDelay + jitter, MAX_RETRY_WAIT_MS);
  }

  private checkRateLimit(): { withinLimit: boolean; remaining: number } {
    const windowHasReset = this.rateLimitReset !== null && this.rateLimitReset.getTime() <= Date.now();
    if (windowHasReset) {
      return { withinLimit: true, remaining: this.rateLimitRemaining };
    }

    return {
      withinLimit: this.rateLimitRemaining > RATE_LIMIT_RESERVE,
      remaining: this.rateLimitRemaining,
    };
  }

  private updateRateLimitInfo(response: AxiosResponse): void {
    const remaining = response.headers['x-ratelimit-remaining'];
    const reset = response.headers['x-ratelimit-reset'];
    
    if (remaining) {
      this.rateLimitRemaining = parseInt(remaining);
    }
    
    if (reset) {
      this.rateLimitReset = new Date(parseInt(reset) * 1000);
    }
  }

  private async request(endpoint: string, retries: number = MAX_RETRIES, etag?: string): Promise<AxiosResponse> {
    const rateLimitCheck = this.checkRateLimit();
    if (!rateLimitCheck.withinLimit) {
      throw new GitHubApiError({
        type: GitHubAPIErrorType.RATE_LIMIT,
        message: `GitHub API rate limit exceeded. ${rateLimitCheck.remaining} requests remaining.`,
        statusCode: 429,
        endpoint,
        timestamp: new Date(),
        rateLimitRemaining: rateLimitCheck.remaining,
      });
    }

    return this.circuitBreaker.execute(async () => {
      let sleptMs = 0;

      for (let i = 0; i < retries; i++) {
        try {
          const headers: Record<string, string> = {
            Authorization: `token ${this.token}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'GitHub-Runner-Monitoring-App/1.0',
          };

          if (etag) {
            headers['If-None-Match'] = etag;
          }

          const response = await axios.get(`${GITHUB_BASE_URL}${endpoint}`, {
            headers,
            timeout: 15000,
            validateStatus: status => (status >= 200 && status < 300) || status === 304,
          });

          this.updateRateLimitInfo(response);
          const outcome = response.status === 304 ? 'not modified (304)' : 'successful';
          console.log(`[AUDIT] GitHub API call to ${endpoint} ${outcome} (${this.rateLimitRemaining} requests remaining)`);

          return response;
        } catch (error: any) {
          const apiError = this.classifyError(error, endpoint);
          const isLastAttempt = i === retries - 1;

          console.error(`[ERROR] GitHub API call failed (attempt ${i + 1}/${retries}): ${apiError.message}`);

          if (isLastAttempt || !this.shouldRetry(apiError, i)) {
            throw apiError;
          }

          const delay = Math.min(this.calculateBackoffDelay(i, apiError), MAX_RETRY_WAIT_MS - sleptMs);
          if (delay <= 0) {
            console.warn(
              `[WARN] Giving up on ${endpoint}: the ${MAX_RETRY_WAIT_MS}ms retry budget is spent. ` +
                `Failing now rather than holding the request open.`
            );
            throw apiError;
          }

          console.log(`[INFO] Retrying GitHub API call to ${endpoint} in ${Math.round(delay)}ms (attempt ${i + 2}/${retries})`);

          sleptMs += delay;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }

      throw new Error('Unexpected error in GitHub API request after all retries');
    }, endpoint);
  }

  async getRunners(org: string): Promise<GitHubRunner[]> {
    const runners: GitHubRunner[] = [];
    let page = 1;

    while (page <= MAX_RUNNER_PAGES) {
      const response = await this.request(
        `/orgs/${org}/actions/runners?per_page=${RUNNERS_PER_PAGE}&page=${page}`
      );
      const body = response.data as GitHubRunnersResponse;
      const pageRunners = body?.runners ?? [];
      runners.push(...pageRunners);

      const shortPage = pageRunners.length < RUNNERS_PER_PAGE;
      const haveAll = typeof body?.total_count === 'number' && runners.length >= body.total_count;
      if (shortPage || haveAll || !hasNextPage(response)) {
        return runners;
      }

      page++;
    }

    console.warn(
      `[WARN] Stopped listing runners for org ${org} at the ${MAX_RUNNER_PAGES}-page cap ` +
        `(${runners.length} runners). Availability counts may be incomplete — raise ` +
        `GITHUB_MAX_RUNNER_PAGES if this org really is this large.`
    );
    return runners;
  }

  async getWorkflowRun(owner: string, repo: string, runId: number): Promise<GitHubWorkflowRun> {
    try {
      const response = await this.request(`/repos/${owner}/${repo}/actions/runs/${runId}`);
      return response.data as GitHubWorkflowRun;
    } catch (error: any) {
      console.error(`[ERROR] Failed to fetch run ${runId} in ${owner}/${repo}: ${error.message}`);
      throw wrapWithContext(error, `Failed to fetch run ${runId} in ${owner}/${repo}`);
    }
  }

  async getJobsForRun(owner: string, repo: string, runId: number): Promise<GitHubJobsResponse> {
    const basePath = `/repos/${owner}/${repo}/actions/runs/${runId}/jobs`;
    const jobs: GitHubJob[] = [];
    let totalCount = 0;
    let page = 1;
    let capped = true;

    try {
      while (page <= MAX_JOB_PAGES) {
        const response = await this.request(`${basePath}?per_page=${JOBS_PER_PAGE}&page=${page}`);
        const body = response.data as Omit<GitHubJobsResponse, 'capped'>;
        const pageJobs = body?.jobs ?? [];
        jobs.push(...pageJobs);
        if (typeof body?.total_count === 'number') {
          totalCount = body.total_count;
        }

        const shortPage = pageJobs.length < JOBS_PER_PAGE;
        const haveAll = totalCount > 0 && jobs.length >= totalCount;
        if (shortPage || haveAll || !hasNextPage(response)) {
          capped = false;
          break;
        }

        page++;
      }

      if (capped) {
        console.warn(
          `[WARN] Stopped listing jobs for run ${runId} in ${owner}/${repo} at the ` +
            `${MAX_JOB_PAGES}-page cap (${jobs.length} jobs). Raise GITHUB_MAX_JOB_PAGES ` +
            `if runs here really are this large.`
        );
      }

      console.log(`[AUDIT] Successfully fetched ${jobs.length} jobs for run ${runId} in ${owner}/${repo}`);
      return { total_count: totalCount || jobs.length, jobs, capped };
    } catch (error: any) {
      console.error(`[ERROR] Failed to fetch jobs for run ${runId} in ${owner}/${repo}: ${error.message}`);
      throw wrapWithContext(error, `Failed to fetch jobs for run ${runId} in ${owner}/${repo}`);
    }
  }

  private buildWorkflowRunsEndpoint(owner: string, repo: string, options?: WorkflowRunsOptions): string {
    let endpoint = `/repos/${owner}/${repo}/actions/runs`;
    const queryParams: string[] = [];

    if (options) {
      if (options.status) {
        queryParams.push(`status=${options.status}`);
      }
      if (options.per_page) {
        queryParams.push(`per_page=${options.per_page}`);
      }
      if (options.page) {
        queryParams.push(`page=${options.page}`);
      }
      if (options.created) {
        queryParams.push(`created=${options.created}`);
      }
      if (options.exclude_pull_requests !== undefined) {
        queryParams.push(`exclude_pull_requests=${options.exclude_pull_requests}`);
      }
      if (options.check_suite_id) {
        queryParams.push(`check_suite_id=${options.check_suite_id}`);
      }
      if (options.head_sha) {
        queryParams.push(`head_sha=${options.head_sha}`);
      }
    }

    if (queryParams.length > 0) {
      endpoint += `?${queryParams.join('&')}`;
    }

    return endpoint;
  }

  private isRunsPageCapped(data: GitHubWorkflowRunsResponse | undefined): boolean {
    const returned = data?.workflow_runs?.length ?? 0;
    return typeof data?.total_count === 'number' && data.total_count > returned;
  }

  async getWorkflowRunsConditional(
    owner: string,
    repo: string,
    options?: WorkflowRunsOptions
  ): Promise<ConditionalResponse<GitHubWorkflowRunsResponse>> {
    const endpoint = this.buildWorkflowRunsEndpoint(owner, repo, options);

    try {
      const stored = etagStore.get(endpoint);
      let response = await this.request(endpoint, MAX_RETRIES, stored?.etag);

      if (response.status === 304) {
        const cached = etagStore.get(endpoint);

        if (cached) {
          const cachedData = cached.data as GitHubWorkflowRunsResponse;
          console.log(`[AUDIT] Workflow runs for ${owner}/${repo} unchanged since last refresh (304, no rate-limit cost)`);
          return { data: cachedData, notModified: true, capped: this.isRunsPageCapped(cachedData) };
        }

        console.warn(
          `[WARN] GitHub answered 304 for ${endpoint} but no stored body is left for it — the ` +
            `ETag outlived its copy. Dropping it and re-requesting in full. Raise ` +
            `GITHUB_ETAG_CACHE_SIZE if this keeps happening.`
        );
        etagStore.delete(endpoint);
        response = await this.request(endpoint);
      }

      const data = response.data as GitHubWorkflowRunsResponse;

      const responseEtag = (response.headers as Record<string, unknown> | undefined)?.['etag'];
      if (typeof responseEtag === 'string' && responseEtag.length > 0) {
        etagStore.set(endpoint, { etag: responseEtag, data });
      }

      console.log(`[AUDIT] Successfully fetched workflow runs for ${owner}/${repo} with ${data?.total_count} total runs`);
      return { data, notModified: false, capped: this.isRunsPageCapped(data) };
    } catch (error: any) {
      console.error(`[ERROR] Failed to fetch workflow runs for ${owner}/${repo}: ${error.message}`);
      throw wrapWithContext(error, `Failed to fetch workflow runs for ${owner}/${repo}`);
    }
  }

  getCircuitBreakerState(): CircuitBreakerState {
    return this.circuitBreaker.getState();
  }

  getRateLimitInfo(): { remaining: number; reset: Date | null } {
    return {
      remaining: this.rateLimitRemaining,
      reset: this.rateLimitReset
    };
  }

}
