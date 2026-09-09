import {
  formatAgo,
  formatCompactDuration,
  formatShortDateTime,
  formatFullTimestamp,
  formatTimeZoneLabel,
} from './format';

describe('formatCompactDuration', () => {
  test('keeps seconds only while they still mean something', () => {
    expect(formatCompactDuration(45_000)).toBe('45s');
    expect(formatCompactDuration(100_000)).toBe('1m 40s');
  });

  test('drops seconds once a wait is measured in minutes', () => {
    expect(formatCompactDuration(26 * 60 * 1000 + 38_000)).toBe('26 min');
    expect(formatCompactDuration(59 * 60 * 1000)).toBe('59 min');
  });

  test('rolls up to hours and days', () => {
    expect(formatCompactDuration(65 * 60 * 1000)).toBe('1h 5m');
    expect(formatCompactDuration((2 * 24 * 60 + 3 * 60) * 60 * 1000)).toBe('2d 3h');
  });

  test('drops an empty trailing unit — "1h", not "1h 0m"', () => {
    expect(formatCompactDuration(60 * 60 * 1000)).toBe('1h');
    expect(formatCompactDuration(2 * 24 * 60 * 60 * 1000)).toBe('2d');
  });

  test('never renders a negative or nonsense duration', () => {
    expect(formatCompactDuration(-5)).toBe('0s');
    expect(formatCompactDuration(Number.NaN)).toBe('0s');
  });
});

describe('formatAgo', () => {
  test('uses the same compact form', () => {
    expect(formatAgo(1_000)).toBe('just now');
    expect(formatAgo(29 * 60 * 1000)).toBe('29 min ago');
  });
});

// The tests run with TZ pinned to Asia/Jerusalem, so that is "this computer".
describe("the viewer's own clock", () => {
  const moment = new Date('2026-08-05T11:32:07Z');

  test('short form is hh:mm dd.mm on the machine the page is open on', () => {
    expect(formatShortDateTime(moment)).toBe('14:32 05.08');
  });

  test('the long form names the zone, so a time is never bare', () => {
    expect(formatFullTimestamp(moment)).toContain('Jerusalem, UTC+3');
    expect(formatFullTimestamp(moment)).toContain('14:32:07');
  });

  test('an unparseable date does not render as "Invalid Date"', () => {
    expect(formatShortDateTime(new Date('nonsense'))).toBe('—');
  });

  test('the short label carries the offset, and follows the clocks', () => {
    expect(formatTimeZoneLabel(moment)).toBe('Jerusalem, UTC+3');
    expect(formatTimeZoneLabel(new Date('2026-01-15T09:00:00Z'))).toBe('Jerusalem, UTC+2');
  });

  test('the short label falls back to the city rather than a gap', () => {
    expect(formatTimeZoneLabel(new Date('nonsense'))).toBe('Jerusalem');
  });
});
