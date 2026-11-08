import {
  AnthropicError,
  createAnthropicAdapter,
  getAnthropicAdapter,
  isSubscriptionToken,
  resetAnthropicAdapter,
} from '../src/adapters/anthropic';

const KEY = 'sk-ant-api03-acme-test-key-0000-WXYZ';

function fakeFetch(answer: number | Error) {
  return jest.fn(async (_url: string, _init: { method: string; headers: Record<string, string> }) => {
    if (answer instanceof Error) throw answer;
    return { status: answer, body: { cancel: async () => undefined } };
  });
}

beforeEach(() => resetAnthropicAdapter());

describe('isSubscriptionToken', () => {
  test.each([
    ['sk-ant-oat01-abc', true],
    ['sk-ant-ort01-abc', true],
    ['  sk-ant-oat01-abc', true],
    ['sk-ant-api03-abc', false],
    ['', false],
    [42, false],
    [undefined, false],
  ])('%p is %p', (key, expected) => {
    expect(isSubscriptionToken(key)).toBe(expected);
  });
});

describe('checkKey', () => {
  test('one GET /v1/models with the key and version headers; 200 is valid', async () => {
    const fetch = fakeFetch(200);
    const adapter = createAnthropicAdapter({ fetch });
    expect(await adapter.checkKey(KEY)).toBe('valid');
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/models');
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({ 'x-api-key': KEY, 'anthropic-version': '2023-06-01' });
    // Redirects are not followed, so the key never reaches another host.
    expect((init as { redirect?: string }).redirect).toBe('manual');
  });

  test.each([301, 302, 307, 308])('a %i redirect throws an AnthropicError with its status', async (status) => {
    const promise = createAnthropicAdapter({ fetch: fakeFetch(status) }).checkKey(KEY);
    await expect(promise).rejects.toMatchObject({ name: 'AnthropicError', status });
  });

  test.each([401, 403])('%i is rejected', async (status) => {
    expect(await createAnthropicAdapter({ fetch: fakeFetch(status) }).checkKey(KEY)).toBe('rejected');
  });

  test.each([500, 503, 429, 404])('%i throws an AnthropicError with the status only', async (status) => {
    const promise = createAnthropicAdapter({ fetch: fakeFetch(status) }).checkKey(KEY);
    await expect(promise).rejects.toBeInstanceOf(AnthropicError);
    await expect(promise).rejects.toMatchObject({ status });
    await expect(promise).rejects.not.toThrow(KEY);
  });

  test('a network error throws an AnthropicError without its text', async () => {
    const promise = createAnthropicAdapter({ fetch: fakeFetch(new Error(`connect ECONNREFUSED ${KEY}`)) }).checkKey(KEY);
    await expect(promise).rejects.toMatchObject({ name: 'AnthropicError', status: null });
    await promise.catch((error: Error) => expect(error.message).not.toContain(KEY));
  });

  test('a subscription token is rejected with no call', async () => {
    const fetch = fakeFetch(200);
    expect(await createAnthropicAdapter({ fetch }).checkKey('sk-ant-oat01-acme')).toBe('rejected');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('mock mode makes no call and accepts the key', async () => {
    const fetch = fakeFetch(500);
    expect(await createAnthropicAdapter({ fetch, mock: true }).checkKey(KEY)).toBe('valid');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('getAnthropicAdapter in mock mode makes no call', async () => {
    const spy = jest.spyOn(globalThis, 'fetch');
    try {
      expect(await getAnthropicAdapter({ USE_MOCK_DATA: 'true' }).checkKey(KEY)).toBe('valid');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
