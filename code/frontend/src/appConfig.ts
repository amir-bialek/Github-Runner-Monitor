// Filled in by /config.js, which the nginx image rewrites on every start from
// the APP_HEADING, APP_TAB_TITLE and the APP_*_PAGE_SIZE / APP_HISTORY_LIMIT
// environment variables. The fallbacks keep the dev server and the tests
// working without that file.
const config = typeof window === 'undefined' ? undefined : window.__APP_CONFIG__;

function positiveNumber(value: number | undefined, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export const APP_HEADING = config?.heading?.trim() || 'GitHub Runner Monitor';
export const APP_TAB_TITLE = config?.tabTitle?.trim() || 'Runner Monitor';
export const HISTORY_LIMIT = positiveNumber(config?.historyLimit, 200);
export const HISTORY_PAGE_SIZE = positiveNumber(config?.historyPageSize, 20);
export const QUEUE_PAGE_SIZE = positiveNumber(config?.queuePageSize, 10);
// The backend sends the whole queue, because the pool dropdown is built from
// it. The ceiling on what the page will list is applied here instead.
export const QUEUE_MAX_ITEMS = positiveNumber(config?.queueMaxItems, 200);
export const RUNNING_PAGE_SIZE = positiveNumber(config?.runningPageSize, 10);
export const RUNNERS_REFRESH_MS = positiveNumber(config?.runnersRefreshSeconds, 30) * 1000;
