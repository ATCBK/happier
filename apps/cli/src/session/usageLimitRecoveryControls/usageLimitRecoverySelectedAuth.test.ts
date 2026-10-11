import { describe, expect, it } from 'vitest';
import { SessionRuntimeIssueV1Schema } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

import { resolveUsageLimitRecoverySelectedAuthFromIssue } from './usageLimitRecoverySelectedAuth';

function issue(profileId = `native:${'a'.repeat(48)}`, groupId: string | null = null) {
  return SessionRuntimeIssueV1Schema.parse({
    v: 1, scope: 'primary_session', status: 'failed', code: 'usage_limit', source: 'usage_limit', occurredAt: 100,
    usageLimit: { v: 1, resetAtMs: 200, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait',
      connectedService: { serviceId: 'claude-subscription', profileId, groupId },
    },
  });
}

describe('resolveUsageLimitRecoverySelectedAuthFromIssue', () => {
  it('does not infer native without binding evidence or from an ordinary native-prefixed profile', () => {
    for (const profileId of [`native:${'a'.repeat(48)}`, 'native:my-profile']) {
      expect(resolveUsageLimitRecoverySelectedAuthFromIssue({ issue: issue(profileId) })).toEqual({
        kind: 'profile', serviceId: 'happier.agent.claude/claude-subscription', profileId,
      });
    }
    expect(resolveUsageLimitRecoverySelectedAuthFromIssue({ issue: issue('native:my-profile'), connectedServices: null })).toEqual({
      kind: 'profile', serviceId: 'happier.agent.claude/claude-subscription', profileId: 'native:my-profile',
    });
  });

  it('preserves explicit group authority and compares normalized required service identity', () => {
    const profileId = `native:${'a'.repeat(48)}`;
    expect(resolveUsageLimitRecoverySelectedAuthFromIssue({ issue: issue(profileId, 'pool'), connectedServices: null,
      requiredConnectedServiceId: 'claude-subscription',
    })).toEqual({ kind: 'group', serviceId: 'happier.agent.claude/claude-subscription', groupId: 'pool', profileId });
    expect(resolveUsageLimitRecoverySelectedAuthFromIssue({ issue: issue(), requiredConnectedServiceId: 'anthropic' })).toBeNull();
  });

  it('reads same-name predecessor profiles through the canonical V2 ingress', () => {
    const profileId = `native:${'a'.repeat(48)}`;
    expect(resolveUsageLimitRecoverySelectedAuthFromIssue({ issue: issue(profileId), connectedServices: {
      v: 1, bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId } },
    } })).toEqual({ kind: 'profile', serviceId: 'happier.agent.claude/claude-subscription', profileId });
  });
});
