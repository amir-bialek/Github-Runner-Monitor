import { explanationFromBackend, toApiError } from './apiError';

function backendAnswered(status: number, body: unknown) {
  return {
    isAxiosError: true,
    message: `Request failed with status code ${status}`,
    response: { status, data: body },
  };
}

describe('toApiError', () => {
  test("prefers the backend's explanation, and records that it came from there", () => {
    const error = toApiError(backendAnswered(500, { error: 'GitHub token not configured' }));

    expect(error.message).toBe('GitHub token not configured');
    expect(error.source).toBe('backend');
    expect(error.status).toBe(500);
  });

  test('falls back to axios when nothing usable came back, and says so', () => {
    const network = toApiError({ message: 'Network Error' });
    expect(network.message).toBe('Network Error');
    expect(network.source).toBe('transport');

    const gateway = toApiError(backendAnswered(502, '<html>502 Bad Gateway</html>'));
    expect(gateway.message).toBe('Request failed with status code 502');
    expect(gateway.source).toBe('transport');

    const blank = toApiError(backendAnswered(500, { error: '   ' }));
    expect(blank.message).toBe('Request failed with status code 500');
    expect(blank.source).toBe('transport');
  });

  test('always produces something a person can read', () => {
    expect(toApiError(null).message).toBe('Something went wrong talking to the monitor.');
    expect(toApiError({}).message).toBe('Something went wrong talking to the monitor.');
  });

  test('keeps the original error for debugging', () => {
    const original = backendAnswered(403, { error: 'GitHub API rate limit exceeded' });
    expect(toApiError(original).cause).toBe(original);
  });
});

describe('explanationFromBackend', () => {
  test('returns the message only when the backend is the one that spoke', () => {
    expect(explanationFromBackend(toApiError(backendAnswered(500, { error: 'No token' })))).toBe(
      'No token',
    );
    expect(explanationFromBackend(toApiError({ message: 'Network Error' }))).toBeNull();
    expect(explanationFromBackend(new Error('Request failed with status code 500'))).toBeNull();
    expect(explanationFromBackend(null)).toBeNull();
  });
});
