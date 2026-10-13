function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readFiniteStatus(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function readHttpStatus(error: unknown): number | null {
  const record = asRecord(error);
  if (!record) return null;

  const response = asRecord(record.response);
  const responseStatus = readFiniteStatus(response?.status);
  if (responseStatus !== null) return responseStatus;

  const data = asRecord(record.data);
  return readFiniteStatus(data?.statusCode) ?? readFiniteStatus(data?.status);
}


const RETRYABLE_CLIENT_ERROR_STATUSES: ReadonlySet<number> = new Set([408, 425, 429]);

/** A non-retryable 4xx refuses these request bytes; transport failures and 5xx remain retryable. */
export function isPermanentRequestStatus(status: number | null | undefined): boolean {
  return typeof status === 'number' && Number.isFinite(status)
    && status >= 400 && status < 500 && !RETRYABLE_CLIENT_ERROR_STATUSES.has(status);
}

export function isPermanentRequestError(error: unknown): boolean {
  return isPermanentRequestStatus(readHttpStatus(error));
}
