import type { ReadinessProbeResult, ReadinessRetryLaterReason } from './managedConnectionTypes.js';

const RETRY_REASON_HEADER = 'X-Happier-Retry-Reason';

/** Anything with a case-insensitive header lookup: fetch `Headers`, axios `AxiosHeaders`. */
export type RetryLaterHeaderSource = Readonly<{ get(name: string): unknown }>;

export type RetryLaterHints = Readonly<{
  retryAfterMs?: number;
  reason?: ReadinessRetryLaterReason;
}>;

function readHeader(headers: RetryLaterHeaderSource, name: string): string | undefined {
  const raw = headers.get(name);
  if (typeof raw === 'string') return raw.trim() || undefined;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return undefined;
}

/** Standard `Retry-After`: delta-seconds or an HTTP date. Anything else is no hint. */
export function parseRetryAfterMs(headers: RetryLaterHeaderSource): number | undefined {
  const raw = readHeader(headers, 'Retry-After');
  if (!raw) return undefined;
  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }
  const timestamp = Date.parse(raw);
  if (Number.isFinite(timestamp)) {
    const deltaMs = timestamp - Date.now();
    if (deltaMs > 0) return deltaMs;
  }
  return undefined;
}

export function readRetryLaterReason(headers: RetryLaterHeaderSource): ReadinessRetryLaterReason | undefined {
  const value = readHeader(headers, RETRY_REASON_HEADER);
  if (value === 'server_restarting') return 'server_restarting';
  if (value === 'probe_failed') return 'probe_failed';
  return undefined;
}

/** What an unavailable response (503 and friends) tells the client about when to come back. */
export function readRetryLaterHints(headers: RetryLaterHeaderSource): RetryLaterHints {
  const retryAfterMs = parseRetryAfterMs(headers);
  const reason = readRetryLaterReason(headers);
  return {
    ...(typeof retryAfterMs === 'number' ? { retryAfterMs } : {}),
    ...(reason ? { reason } : {}),
  };
}

export function buildRetryLaterProbeResultFromResponse(
  response: Readonly<{ headers: RetryLaterHeaderSource }>,
  errorMessage: string,
): Extract<ReadinessProbeResult, { status: 'retry_later' }> {
  return {
    status: 'retry_later',
    ...readRetryLaterHints(response.headers),
    errorMessage,
  };
}
