import { describe, expect, it } from 'vitest';
import { isCodexRequestUsageIdentityContradicted, resolveCodexRequestUsageAttribution } from './requestUsageAttribution.js';

describe('Codex request-attempt usage evidence', () => {
  it('uses the dispatched selector snapshot and never a later selected account', () => {
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    let selector = { profileId: 'account-a' };
    const dispatchedIdentity = selector;
    selector = { profileId: 'account-b' };
    const input = { turnId: 'host-turn', service, scope: 'turn_delta' as const, matchesNativeAttempt: true };
    expect(resolveCodexRequestUsageAttribution({ ...input, requestIdentity: dispatchedIdentity })).toEqual({
      v: 1, turnId: 'host-turn', source: { kind: 'native', connectedAccount: { service, accountId: 'account-a' } },
    });
    expect(resolveCodexRequestUsageAttribution({ ...input, requestIdentity: selector })).toMatchObject({
      source: { connectedAccount: { accountId: 'account-b' } },
    });
  });

  it('refuses invalidated, combined, foreign-attempt and unqualified evidence', () => {
    const input = { turnId: 'host-turn', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
      requestIdentity: { profileId: 'account-a' }, scope: 'turn_delta' as const, matchesNativeAttempt: true };
    expect(resolveCodexRequestUsageAttribution({ ...input, requestIdentity: null })).toBeUndefined();
    expect(resolveCodexRequestUsageAttribution({ ...input, scope: 'session_cumulative' })).toBeUndefined();
    expect(resolveCodexRequestUsageAttribution({ ...input, matchesNativeAttempt: false })).toBeUndefined();
    expect(resolveCodexRequestUsageAttribution({ ...input, service: undefined })).toBeUndefined();
  });

  it('withdraws a dispatched identity when the native account read contradicts it', () => {
    const identity = { profileId: 'account-a', providerAccountId: 'vendor-a' };
    expect(isCodexRequestUsageIdentityContradicted(identity, { providerAccountId: 'vendor-b' })).toBe(true);
    expect(isCodexRequestUsageIdentityContradicted(identity, { providerAccountId: 'vendor-a' })).toBe(false);
    expect(isCodexRequestUsageIdentityContradicted(identity, null)).toBe(false);
    expect(isCodexRequestUsageIdentityContradicted(null, { providerAccountId: 'vendor-b' })).toBe(false);
  });
});
