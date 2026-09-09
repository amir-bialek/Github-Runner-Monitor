export const UNKNOWN_TEXT = 'unknown';

export const MISSING_TEXT = '—';

export function orUnknown(value: string | null | undefined): string {
  return value && value.length > 0 ? value : UNKNOWN_TEXT;
}

export function jobLabel(workflowName: string | null, name: string): string {
  return workflowName ? `${workflowName} · ${name}` : name;
}
