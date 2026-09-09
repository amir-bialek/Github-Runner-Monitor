import { ThemeMode } from '../theme';

export const THEME_STORAGE_KEY = 'runner-monitor.theme';

function isMode(value: string | null): value is ThemeMode {
  return value === 'light' || value === 'dark';
}

/** The stored choice, or the one the operating system is set to on a first visit. */
export function readStoredThemeMode(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (isMode(stored)) return stored;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function storeThemeMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // A browser that refuses storage still gets the choice for this visit.
  }
}
