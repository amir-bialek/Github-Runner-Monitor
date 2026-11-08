// Shared readers for numeric settings that arrive as environment variables
// from the Helm values. A mistyped value used to become NaN, and
// slice(0, NaN) returns nothing, so one bad character in the Helm values
// emptied a whole section of the page. Both readers warn and fall back.

type Env = Record<string, string | undefined>;

export function positiveInt(name: string, fallback: number, env: Env = process.env): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.warn(`[WARN] ${name}="${raw}" is not a whole number above zero — using ${fallback}`);
    return fallback;
  }
  return parsed;
}

// Same pattern for decimal values such as spend limits in US dollars, where
// 0 is allowed (it means "no limit").
export function nonNegativeNumber(name: string, fallback: number, env: Env = process.env): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw.trim());
  if (raw.trim() === '' || !Number.isFinite(parsed) || parsed < 0) {
    console.warn(`[WARN] ${name}="${raw}" is not a number of zero or more — using ${fallback}`);
    return fallback;
  }
  return parsed;
}
