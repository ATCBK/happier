import { describe, expect, it } from 'vitest';

import { mapClaudeProviderFailureToUsageDetails } from './runtimeIssues.js';

describe('mapClaudeProviderFailureToUsageDetails', () => {
  it('preserves StopFailure classification and provider retry timing through the canonical parser', () => {
    expect(mapClaudeProviderFailureToUsageDetails({ error_type: 'rate_limit' })).toMatchObject({ quotaScope: 'account' });
    expect(mapClaudeProviderFailureToUsageDetails({ status: 429, error: { retry_after: 2 } }))
      .toMatchObject({ retryAfterMs: 2000 });
    expect(mapClaudeProviderFailureToUsageDetails({ type: 'rate_limit_error' }))
      .toMatchObject({ quotaScope: 'account' });
  });
  it('uses native allowance evidence rather than the rate-limit error category', () => {
    const error = { status: 429, code: 'rate_limit_error', retryAfterMs: 1500 };
    expect(mapClaudeProviderFailureToUsageDetails(error)).toMatchObject({
      quotaScope: 'account', retryAfterMs: 1500,
    });
    expect(mapClaudeProviderFailureToUsageDetails(error)?.providerLimitId).toBeUndefined();
    expect(mapClaudeProviderFailureToUsageDetails({ ...error, providerLimitId: 'seven_day_opus' })?.providerLimitId)
      .toBe('seven_day_opus');
    expect(mapClaudeProviderFailureToUsageDetails({ status: 401, message: 'rate limit' })).toBeNull();
  });
  it('normalizes numeric provider reset epochs at the shared boundary', () => {
    const cases = [
      [1_700_000_000, 1_700_000_000_000],
      [1_700_000_000_000, 1_700_000_000_000],
      [1_000_000_000_000, 1_000_000_000_000],
      ['1700000000', 1_700_000_000_000],
      ['1700000000000', 1_700_000_000_000],
      ['100000000000', 100_000_000_000_000],
      ['1000000000000', 1_000_000_000_000],
    ] as const;

    for (const [value, expected] of cases) {
      expect(mapClaudeProviderFailureToUsageDetails({
        status: 429,
        reset_at: value,
      })).toMatchObject({
        resetAtMs: expected,
      });
    }
  });
});
