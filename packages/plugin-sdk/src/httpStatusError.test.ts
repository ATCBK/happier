import { describe, expect, it } from 'vitest';

import { isPermanentRequestError, readHttpStatus } from './http/index.js';

describe('HTTP request retry classification', () => {
  it('keeps timeouts, early-data refusals and rate limits retryable while refusing stable client errors', () => {
    for (const status of [408, 425, 429, 500]) {
      expect(isPermanentRequestError({ response: { status } })).toBe(false);
    }
    for (const status of [400, 403, 426]) {
      expect(isPermanentRequestError({ response: { status } })).toBe(true);
    }
    expect(isPermanentRequestError(new Error('Connection lost'))).toBe(false);
  });

  it('reads finite HTTP response/data status carriers and preserves their precedence', () => {
    expect(readHttpStatus({ response: { status: 401 }, data: { statusCode: 500 } })).toBe(401);
    expect(readHttpStatus({ response: { status: Number.NaN }, data: { statusCode: 403 } })).toBe(403);
    expect(readHttpStatus({ data: { status: 429 } })).toBe(429);
    expect(isPermanentRequestError({ data: { statusCode: 400 } })).toBe(true);
    expect(readHttpStatus({ response: { status: Number.POSITIVE_INFINITY }, data: { status: Number.NaN } })).toBeNull();
    expect(readHttpStatus({ status: 1 })).toBeNull();
  });
});
