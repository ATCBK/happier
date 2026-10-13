import { describe, expect, it } from 'vitest';
import { RegistryFetchResponseV1Schema } from './registryRpcV1.js';
import { readRegistryHttpRateLimitV1, RegistrySourceStatusV1Schema } from './registryListV1.js';

describe('registry rate-limit wire admission', () => {
  it('admits an observed rate limit without a reset timestamp while keeping the response closed', () => {
    const response = { op: 'list', page: { sourceId: 'headerless', status: { state: 'rate_limited' }, items: [], nextCursor: null } };
    expect(RegistryFetchResponseV1Schema.parse(response)).toEqual(response);
    expect(RegistryFetchResponseV1Schema.safeParse({ ...response, page: { ...response.page,
      status: { ...response.page.status, cooldown: 60 } } }).success).toBe(false);
    expect(RegistryFetchResponseV1Schema.safeParse({ ...response, page: { ...response.page,
      status: { ...response.page.status, retryAt: -1 } } }).success).toBe(false);
  });
  it('uses upstream reset evidence for a host throttle, leaving invalid evidence without a timestamp', () => {
    const read = (status: number, headers: Record<string, string>) => readRegistryHttpRateLimitV1({ status, headers: new Headers(headers), nowMs: 1_000 });
    expect(read(429, { 'retry-after': '2' })).toEqual({ state: 'rate_limited', retryAt: 3_000 });
    expect(read(429, { 'retry-after': 'Thu, 01 Jan 1970 00:00:05 GMT' })).toEqual({ state: 'rate_limited', retryAt: 5_000 });
    expect(read(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '10' })).toEqual({ state: 'rate_limited', retryAt: 10_000 });
    expect(RegistrySourceStatusV1Schema.parse(read(429, { 'retry-after': '-1', 'x-ratelimit-reset': 'invalid' })))
      .toEqual({ state: 'rate_limited' });
    expect(read(403, {})).toBeNull();
  });
});
