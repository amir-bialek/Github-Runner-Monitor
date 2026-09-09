export type ApiErrorSource =
  | 'backend'
  | 'transport';

export class ApiError extends Error {
  readonly source: ApiErrorSource;
  readonly status?: number;

  constructor(
    message: string,
    options: { source: ApiErrorSource; status?: number; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = 'ApiError';
    this.source = options.source;
    this.status = options.status;
  }
}

const FALLBACK_MESSAGE = 'Something went wrong talking to the monitor.';

function usableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function backendErrorMessage(error: unknown): string | null {
  const body = (error as { response?: { data?: unknown } } | null)?.response?.data;
  return usableString((body as { error?: unknown } | null | undefined)?.error);
}

export function toApiError(error: unknown): ApiError {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;

  const fromBackend = backendErrorMessage(error);
  if (fromBackend) {
    return new ApiError(fromBackend, { source: 'backend', status, cause: error });
  }

  const fromAxios = usableString((error as { message?: unknown } | null)?.message);
  return new ApiError(fromAxios ?? FALLBACK_MESSAGE, { source: 'transport', status, cause: error });
}

export function explanationFromBackend(error: unknown): string | null {
  if (!error) return null;
  if ((error as { source?: unknown }).source !== 'backend') return null;
  return usableString((error as { message?: unknown }).message);
}
