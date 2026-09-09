/** Every time on the page is the viewer's own clock, read fresh so a machine change is picked up. */
function intlZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** "Europe/Berlin" reads as "Berlin"; "UTC" stays as it is. */
function cityOf(zone: string): string {
  return (zone.split('/').pop() ?? zone).replace(/_/g, ' ');
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(key: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const zone = intlZone();
  const cacheKey = `${key}|${zone}`;
  const cached = formatterCache.get(cacheKey);
  if (cached) return cached;

  const created = new Intl.DateTimeFormat('en-GB', { ...options, timeZone: zone });
  formatterCache.set(cacheKey, created);
  return created;
}

const clockTimeFormat = () =>
  formatter('clock', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

const shortTimeFormat = () =>
  formatter('shortTime', { hour: '2-digit', minute: '2-digit', hour12: false });

const shortDateFormat = () => formatter('shortDate', { day: '2-digit', month: '2-digit' });

const fullTimestampFormat = () =>
  formatter('full', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';

  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;

  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) return `${totalHours}h ${minutes}m`;

  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return `${days}d ${hours}h`;
}

export function formatCompactDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';

  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 2) return `${totalMinutes}m ${totalSeconds % 60}s`;
  if (totalMinutes < 60) return `${totalMinutes} min`;

  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    const minutes = totalMinutes % 60;
    return minutes === 0 ? `${totalHours}h` : `${totalHours}h ${minutes}m`;
  }

  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

export function formatAgo(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  if (ms < 3000) return 'just now';
  return `${formatCompactDuration(ms)} ago`;
}

function isValid(date: Date): boolean {
  return Number.isFinite(date.getTime());
}

export function parseTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return isValid(date) ? date : null;
}

export function formatClockTime(date: Date): string {
  if (!isValid(date)) return '—';
  return clockTimeFormat().format(date);
}

export function formatShortDateTime(date: Date): string {
  if (!isValid(date)) return '—';
  return `${shortTimeFormat().format(date)} ${shortDateFormat().format(date).replace(/\//g, '.')}`;
}

export function formatDateThenTime(date: Date): string {
  if (!isValid(date)) return '—';
  return `${shortDateFormat().format(date).replace(/\//g, '.')} | ${shortTimeFormat().format(date)}`;
}

export function formatFullTimestamp(date: Date): string {
  if (!isValid(date)) return '—';
  return `${fullTimestampFormat().format(date)} (${formatTimeZoneLabel(date)})`;
}

function formatUtcOffset(date: Date): string | null {
  if (!isValid(date)) return null;
  try {
    const name = new Intl.DateTimeFormat('en-GB', { timeZone: intlZone(), timeZoneName: 'longOffset' })
      .formatToParts(date)
      .find((part) => part.type === 'timeZoneName')?.value;
    const match = name ? /^GMT([+-])(\d{2}):(\d{2})$/.exec(name) : null;
    if (!match) return name === 'GMT' ? 'UTC+0' : null;

    const [, sign, hours, minutes] = match;
    const hour = String(Number(hours));
    return minutes === '00' ? `UTC${sign}${hour}` : `UTC${sign}${hour}:${minutes}`;
  } catch {
    return null;
  }
}

export function formatTimeZoneLabel(date: Date): string {
  const city = cityOf(intlZone());
  if (city === 'UTC') return 'UTC';
  const offset = formatUtcOffset(date);
  return offset ? `${city}, ${offset}` : city;
}
