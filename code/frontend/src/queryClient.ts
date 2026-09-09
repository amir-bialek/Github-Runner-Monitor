import { QueryClient } from '@tanstack/react-query';

const MAX_RETRIES = 1;

function isTimeout(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return cause?.code === 'ECONNABORTED';
}

function httpStatus(error: unknown): number | null {
  return (error as { status?: number } | null)?.status ?? null;
}

export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_RETRIES) return false;
  if (isTimeout(error)) return false;

  const status = httpStatus(error);
  if (status !== null && status >= 400 && status < 500) return false;

  if ((error as { source?: unknown } | null)?.source === 'backend') return false;

  return true;
}

export const REFRESH_INTERVAL_MS = 15000;

export const createQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: {
        retry: 3,
        staleTime: 0,
        refetchInterval: REFRESH_INTERVAL_MS,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
      },
    },
  });

export const queryClient = createQueryClient();
