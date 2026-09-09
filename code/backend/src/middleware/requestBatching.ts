import { Request, Response, NextFunction } from 'express';

export function toError(value: unknown): Error {
  if (value instanceof Error) return value;

  if (value !== null && typeof value === 'object') {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) {
      return Object.assign(new Error(message), value);
    }
  }

  return new Error(String(value));
}

interface PendingRequest<T = any> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timestamp: number;
}

interface BatchedRequest<T = any> {
  requests: PendingRequest<T>[];
  executor: () => Promise<T>;
  cacheKey?: string | undefined;
}

export class RequestBatcher {
  private pendingRequests: Map<string, BatchedRequest> = new Map();
  private readonly BATCH_WINDOW = parseInt(process.env.REQUEST_BATCH_WINDOW_MS || '100');
  private readonly MAX_BATCH_SIZE = parseInt(process.env.MAX_BATCH_SIZE || '10');

  async batchRequest<T>(
    requestId: string,
    executor: () => Promise<T>,
    cacheKey?: string
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const now = Date.now();

      const existingBatch = this.pendingRequests.get(requestId);

      if (existingBatch && this.canJoinBatch(existingBatch, now)) {
        existingBatch.requests.push({ resolve, reject, timestamp: now });

        if (cacheKey && !existingBatch.cacheKey) {
          existingBatch.cacheKey = cacheKey;
        }
      } else {
        if (existingBatch) {
          void this.executeBatch(requestId);
        }

        const batch: BatchedRequest<T> = {
          requests: [{ resolve, reject, timestamp: now }],
          executor,
          ...(cacheKey !== undefined && { cacheKey }),
        };

        this.pendingRequests.set(requestId, batch);

        setTimeout(() => {
          this.executeBatch(requestId);
        }, this.BATCH_WINDOW);
      }
    });
  }

  private canJoinBatch<T>(batch: BatchedRequest<T>, now: number): boolean {
    const oldestRequest = Math.min(...batch.requests.map(r => r.timestamp));
    const isWithinWindow = now - oldestRequest < this.BATCH_WINDOW;
    const isUnderMaxSize = batch.requests.length < this.MAX_BATCH_SIZE;

    return isWithinWindow && isUnderMaxSize;
  }

  private async executeBatch<T>(requestId: string): Promise<void> {
    const batch = this.pendingRequests.get(requestId);
    if (!batch) return;

    this.pendingRequests.delete(requestId);

    try {
      const result = await batch.executor();

      batch.requests.forEach(pending => {
        pending.resolve(result);
      });

    } catch (error) {
      batch.requests.forEach(pending => {
        pending.reject(toError(error));
      });
    }
  }

  getStats() {
    return {
      pendingRequests: this.pendingRequests.size,
      batchWindow: this.BATCH_WINDOW,
      maxBatchSize: this.MAX_BATCH_SIZE,
    };
  }

  clear() {
    this.pendingRequests.clear();
  }
}

export const requestBatcher = new RequestBatcher();

export function withRequestBatching<T = any>(
  requestId: string,
  executor: () => Promise<T>,
  cacheKey?: string
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await requestBatcher.batchRequest(requestId, executor, cacheKey);
      res.json(result);
    } catch (error) {
      next(error);
    }
  };
}
