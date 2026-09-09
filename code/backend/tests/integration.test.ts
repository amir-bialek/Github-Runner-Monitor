import request from 'supertest';
import { app } from '../src/app';

process.env.GITHUB_ORGANIZATION = 'test-org';

describe('API Endpoint Integration', () => {
  test('health endpoint returns performance metrics', async () => {
    const response = await request(app).get('/health').expect(200);

    expect(response.body.status).toBe('OK');
    expect(response.body.metrics).toBeDefined();
    expect(response.body.metrics.totalRequests).toBeDefined();
  });

  test('runners endpoint returns 500 when token not configured and mock mode is off', async () => {
    const previousMock = process.env.USE_MOCK_DATA;
    const previousToken = process.env.GITHUB_TOKEN;
    process.env.USE_MOCK_DATA = 'false';
    delete process.env.GITHUB_TOKEN;

    try {
      const response = await request(app).get('/runners').expect(500);
      expect(response.body.error).toBe('GitHub token not configured');
    } finally {
      process.env.USE_MOCK_DATA = previousMock;
      if (previousToken !== undefined) process.env.GITHUB_TOKEN = previousToken;
    }
  });

  test.each([
    '/validation/cache-test',
    '/validation/github-client-test',
    '/validation/performance-metrics',
  ])('the removed debug route %s returns 404', async route => {
    await request(app).get(route).expect(404);
  });

  test('health does not expose internal cache sizes or limits', async () => {
    const response = await request(app).get('/health').expect(200);
    const body = JSON.stringify(response.body);

    expect(body).not.toContain('maxSize');
    expect(body).not.toContain('calculatedSize');
  });

  test('the four data routes all answer concurrently', async () => {
    const previousMock = process.env.USE_MOCK_DATA;
    process.env.USE_MOCK_DATA = 'true';

    try {
      const responses = await Promise.all([
        request(app).get('/runners'),
        request(app).get('/scale-sets'),
        request(app).get('/jobs/queue'),
        request(app).get('/jobs/running'),
      ]);

      responses.forEach(response => {
        expect(response.status).toBe(200);
      });

      expect(Array.isArray(responses[0]!.body)).toBe(true);
      expect(Array.isArray(responses[1]!.body)).toBe(true);
      expect(Array.isArray(responses[2]!.body.items)).toBe(true);
      expect(Array.isArray(responses[3]!.body.items)).toBe(true);
    } finally {
      process.env.USE_MOCK_DATA = previousMock;
    }
  });

  test('error handling works for invalid endpoints', async () => {
    const response = await request(app).get('/nonexistent-endpoint').expect(404);

    expect(response.status).toBe(404);
  });
});
