import { describe, expect, it } from 'vitest';

import type { ConnectedServiceRuntimeFailureClassification } from './types';
import { isCurrentUsageLimitRecoveryAccount } from './isCurrentUsageLimitRecoveryAccount';

const classification: ConnectedServiceRuntimeFailureClassification = {
  kind: 'usage_limit', limitCategory: 'usage_limit', quotaScope: 'account',
  serviceId: 'happier.agent.codex/openai-codex', profileId: 'work', groupId: null,
  resetsAtMs: 1_000, planType: null, rateLimits: null, source: 'structured_provider_error',
  sourceProviderAccountId: 'account-work', expectedCredentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
};

describe('isCurrentUsageLimitRecoveryAccount', () => {
  it('accepts a rotated credential for the same provider account, not a relinked profile', () => {
    expect(isCurrentUsageLimitRecoveryAccount({ classification, providerAccountId: 'account-work',
      credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb' })).toBe(true);
    expect(isCurrentUsageLimitRecoveryAccount({ classification, providerAccountId: 'account-other',
      credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa' })).toBe(false);
  });

  it('requires the exact saved credential revision when no account subject was recorded', () => {
    const withoutAccount = { ...classification, sourceProviderAccountId: null };
    expect(isCurrentUsageLimitRecoveryAccount({ classification: withoutAccount, providerAccountId: null,
      credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa' })).toBe(true);
    expect(isCurrentUsageLimitRecoveryAccount({ classification: withoutAccount, providerAccountId: null,
      credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb' })).toBe(false);
    expect(isCurrentUsageLimitRecoveryAccount({ classification: { ...withoutAccount, expectedCredentialRevision: null },
      providerAccountId: null, credentialRevision: null })).toBe(false);
  });

  it('does not authorize group switching or non-account temporary retry from an account reset', () => {
    for (const ineligible of [
      { ...classification, groupId: 'group-work' },
      { ...classification, quotaScope: 'model' as const },
      { ...classification, kind: 'temporary_throttle' as const },
    ]) {
      expect(isCurrentUsageLimitRecoveryAccount({ classification: ineligible, providerAccountId: 'account-work',
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa' })).toBe(false);
    }
  });
});
