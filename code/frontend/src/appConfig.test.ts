import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadConfig(value: unknown) {
  vi.resetModules();
  if (value === undefined) {
    delete (window as unknown as Record<string, unknown>).__APP_CONFIG__;
  } else {
    (window as unknown as Record<string, unknown>).__APP_CONFIG__ = value;
  }
  return import('./appConfig');
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__APP_CONFIG__;
});

describe('app config', () => {
  it('takes the heading and the tab title from config.js', async () => {
    const config = await loadConfig({ heading: 'Acme CI Monitor', tabTitle: 'CI Monitor' });

    expect(config.APP_HEADING).toBe('Acme CI Monitor');
    expect(config.APP_TAB_TITLE).toBe('CI Monitor');
  });

  it('falls back to the built-in names when config.js is missing', async () => {
    const config = await loadConfig(undefined);

    expect(config.APP_HEADING).toBe('GitHub Runner Monitor');
    expect(config.APP_TAB_TITLE).toBe('Runner Monitor');
  });

  it('treats an empty or blank value as not set', async () => {
    const config = await loadConfig({ heading: '   ', tabTitle: '' });

    expect(config.APP_HEADING).toBe('GitHub Runner Monitor');
    expect(config.APP_TAB_TITLE).toBe('Runner Monitor');
  });
});
