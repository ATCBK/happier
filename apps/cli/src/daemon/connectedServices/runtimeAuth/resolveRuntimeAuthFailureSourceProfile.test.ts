import { describe, expect, it, vi } from 'vitest';

import { resolveRuntimeAuthFailureSourceProfile } from './resolveRuntimeAuthFailureSourceProfile';

const classification = {
  kind: 'usage_limit',
  limitCategory: 'usage_limit',
  serviceId: 'claude-subscription',
  profileId: 'launch-profile',
  groupId: 'claude',
  groupGeneration: 4,
  expectedCredentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
  sourceProviderAccountId: 'acct-live',
  resetsAtMs: null,
  planType: null,
  rateLimits: null,
  source: 'structured_provider_error',
} as const;

describe('resolveRuntimeAuthFailureSourceProfile', () => {
  it('keeps account-only service attribution independent of incidental organization metadata', async () => {
    await expect(resolveRuntimeAuthFailureSourceProfile({
      classification: { ...classification, serviceId: 'happier.agent.codex/openai-codex' },
      getGroupMembers: async () => [{ profileId: 'live-profile' }],
      resolveProviderAccountIdentity: async () => ({ providerAccountId: 'acct-live', providerOrganizationId: 'metadata-org' }),
    })).resolves.toMatchObject({ profileId: 'live-profile' });
  });

  it('does not use user-only quota evidence when the service requires organization context', async () => {
    await expect(resolveRuntimeAuthFailureSourceProfile({ classification, requiresProviderOrganizationId: true,
      getGroupMembers: async () => [{ profileId: 'launch-profile' }],
      resolveProviderAccountIdentity: async () => ({ providerAccountId: 'acct-live' }),
    })).resolves.toMatchObject({ profileId: null, groupGeneration: null, expectedCredentialRevision: null });
  });

  it('attributes the observed organization rather than the stale launch member for the same provider user', async () => {
    await expect(resolveRuntimeAuthFailureSourceProfile({
      classification: { ...classification, sourceProviderOrganizationId: 'org-live' },
      getGroupMembers: async () => [{ profileId: 'launch-profile' }, { profileId: 'live-profile' }],
      resolveProviderAccountIdentity: async (profileId) => ({
        providerAccountId: 'acct-live', providerOrganizationId: profileId === 'live-profile' ? 'org-live' : 'org-old',
      }),
    })).resolves.toMatchObject({ profileId: 'live-profile', groupGeneration: null, expectedCredentialRevision: null });
  });

  it('maps exact provider account evidence to the unique group member and drops stale tuple fields', async () => {
    await expect(resolveRuntimeAuthFailureSourceProfile({
      classification,
      getGroupMembers: async () => [{ profileId: 'launch-profile' }, { profileId: 'live-profile' }],
      resolveProviderAccountIdentity: async (profileId) => ({ providerAccountId: profileId === 'live-profile' ? 'acct-live' : 'acct-old' }),
    })).resolves.toMatchObject({
      profileId: 'live-profile',
      groupGeneration: null,
      expectedCredentialRevision: null,
    });
  });

  it('clears an ambiguous stale source tuple', async () => {
    const result = await resolveRuntimeAuthFailureSourceProfile({
      classification,
      getGroupMembers: async () => [{ profileId: 'a' }, { profileId: 'b' }],
      resolveProviderAccountIdentity: async () => ({ providerAccountId: 'acct-live' }),
    });
    expect(result).toMatchObject({ profileId: null, groupGeneration: null, expectedCredentialRevision: null });
  });

  it('does not load the group without provider account evidence', async () => {
    const getGroupMembers = vi.fn(async () => [{ profileId: 'a' }]);
    const input = { ...classification, sourceProviderAccountId: null };
    expect(await resolveRuntimeAuthFailureSourceProfile({
      classification: input,
      getGroupMembers,
      resolveProviderAccountIdentity: async () => ({ providerAccountId: 'acct-live' }),
    })).toBe(input);
    expect(getGroupMembers).not.toHaveBeenCalled();
  });
});
