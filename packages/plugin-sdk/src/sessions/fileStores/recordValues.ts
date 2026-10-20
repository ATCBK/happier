/** Realm-neutral native record values shared by identity and file-store readers. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function readTrimmedString(value: unknown): string | null {
  const raw = readString(value);
  return raw ? raw.trim() : null;
}

export function parseTimestampMs(value: unknown): number | null {
  if (typeof value === 'string' && value.trim().length > 0) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) && ms >= 0 ? Math.trunc(ms) : null;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    const truncated = Math.trunc(value);
    return truncated < 1_000_000_000_000 ? truncated * 1000 : truncated;
  }
  return null;
}

export function parseJsonLine(line: string): unknown | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}
