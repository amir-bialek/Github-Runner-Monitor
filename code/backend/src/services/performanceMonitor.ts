interface APICallMetrics {
  endpoint: string;
  method: string;
  statusCode: number;
  responseTime: number;
  timestamp: number;
  success: boolean;
  errorType?: string;
  rateLimitRemaining?: number;
}

interface CacheMetrics {
  cacheType: 'runners' | 'jobsLive' | 'jobsHistory' | 'repos';
  operation: 'get' | 'set' | 'delete';
  key: string;
  hit: boolean;
  responseTime: number;
  timestamp: number;
}

interface PerformanceMetrics {
  apiCalls: APICallMetrics[];
  cacheOperations: CacheMetrics[];
  uptime: number;
  totalRequests: number;
  errorRate: number;
  averageResponseTime: number;
}

class MetricsCollector {
  private metrics: PerformanceMetrics = {
    apiCalls: [],
    cacheOperations: [],
    uptime: Date.now(),
    totalRequests: 0,
    errorRate: 0,
    averageResponseTime: 0,
  };

  private readonly MAX_METRICS_HISTORY = 1000;

  recordAPICall(metrics: Omit<APICallMetrics, 'timestamp'>): void {
    const fullMetrics: APICallMetrics = {
      ...metrics,
      timestamp: Date.now(),
    };

    this.metrics.apiCalls.push(fullMetrics);
    this.metrics.totalRequests++;

    if (this.metrics.apiCalls.length > this.MAX_METRICS_HISTORY) {
      this.metrics.apiCalls = this.metrics.apiCalls.slice(-this.MAX_METRICS_HISTORY);
    }

    this.updateAggregatedMetrics();
  }

  recordCacheOperation(metrics: Omit<CacheMetrics, 'timestamp'>): void {
    const fullMetrics: CacheMetrics = {
      ...metrics,
      timestamp: Date.now(),
    };

    this.metrics.cacheOperations.push(fullMetrics);

    if (this.metrics.cacheOperations.length > this.MAX_METRICS_HISTORY) {
      this.metrics.cacheOperations = this.metrics.cacheOperations.slice(-this.MAX_METRICS_HISTORY);
    }
  }

  private updateAggregatedMetrics(): void {
    const recentApiCalls = this.metrics.apiCalls.slice(-100);
    const successfulCalls = recentApiCalls.filter(call => call.success);
    const errorCalls = recentApiCalls.filter(call => !call.success);

    this.metrics.errorRate = recentApiCalls.length > 0 ? (errorCalls.length / recentApiCalls.length) * 100 : 0;

    const responseTimes = recentApiCalls
      .filter(call => call.success)
      .map(call => call.responseTime);

    this.metrics.averageResponseTime = responseTimes.length > 0
      ? responseTimes.reduce((sum, time) => sum + time, 0) / responseTimes.length
      : 0;
  }

  getMetrics(): PerformanceMetrics {
    return {
      ...this.metrics,
      uptime: Date.now() - this.metrics.uptime,
    };
  }

  getEndpointMetrics(endpoint: string): APICallMetrics[] {
    return this.metrics.apiCalls.filter(call => call.endpoint === endpoint);
  }

  getCacheMetrics(cacheType: 'runners' | 'jobsLive' | 'jobsHistory' | 'repos'): CacheMetrics[] {
    return this.metrics.cacheOperations.filter(op => op.cacheType === cacheType);
  }

  resetMetrics(): void {
    this.metrics = {
      apiCalls: [],
      cacheOperations: [],
      uptime: Date.now(),
      totalRequests: 0,
      errorRate: 0,
      averageResponseTime: 0,
    };
  }
}

export const metricsCollector = new MetricsCollector();

export const recordAPICallStart = (endpoint: string, method: string = 'GET'): { end: (statusCode: number, errorType?: string, rateLimitRemaining?: number) => void } => {
  const startTime = Date.now();

  return {
    end: (statusCode: number, errorType?: string, rateLimitRemaining?: number) => {
      const responseTime = Date.now() - startTime;
      const success = statusCode >= 200 && statusCode < 300;

      metricsCollector.recordAPICall({
        endpoint,
        method,
        statusCode,
        responseTime,
        success,
        ...(errorType !== undefined && { errorType }),
        ...(rateLimitRemaining !== undefined && { rateLimitRemaining }),
      });
    }
  };
};

export const recordCacheOperation = (
  cacheType: 'runners' | 'jobsLive' | 'jobsHistory' | 'repos',
  operation: 'get' | 'set' | 'delete',
  key: string,
  hit: boolean
): void => {
  const startTime = Date.now();

  metricsCollector.recordCacheOperation({
    cacheType,
    operation,
    key,
    hit,
    responseTime: Date.now() - startTime,
  });
};

export const getHealthMetrics = () => {
  const metrics = metricsCollector.getMetrics();

  return {
    uptime: Math.floor(metrics.uptime / 1000),
    totalRequests: metrics.totalRequests,
    errorRate: Math.round(metrics.errorRate * 100) / 100,
    averageResponseTime: Math.round(metrics.averageResponseTime),
    cacheStats: {
      runnersCacheSize: 0,
      jobsLiveCacheSize: 0,
      jobsHistoryCacheSize: 0,
    },
    recentEndpoints: metrics.apiCalls.slice(-10).map(call => ({
      endpoint: call.endpoint,
      statusCode: call.statusCode,
      responseTime: call.responseTime,
      timestamp: new Date(call.timestamp).toISOString(),
    })),
  };
};
