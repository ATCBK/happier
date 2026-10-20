import { describe, expect, it } from 'vitest';

import { RuntimeAuthRecoveryScheduler } from './RuntimeAuthRecoveryScheduler';
import { checkRuntimeAuthUsageLimitRecovery } from './checkRuntimeAuthUsageLimitRecovery';
import type { ConnectedServiceRuntimeFailureClassification } from './types';

describe('checkRuntimeAuthUsageLimitRecovery', () => {
  it.each([false, true])('reports the canonical provider proof after a manual wake when proof=%s', async (publishProof) => {
    const sessionId = 'manual-proof-session';
    const classification: ConnectedServiceRuntimeFailureClassification = {
      kind: 'usage_limit', limitCategory: 'usage_limit',
      serviceId: 'happier.agent.codex/openai-codex', profileId: 'primary', groupId: null,
      resetsAtMs: 5_000, retryAfterMs: null, quotaScope: 'account', providerLimitId: 'weekly',
      action: null, planType: null, rateLimits: null, source: 'structured_provider_error',
    };
    let scheduler: RuntimeAuthRecoveryScheduler;
    scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      recover: async () => {
        if (publishProof) {
          await scheduler.markProviderOutcomeProofByIdentity({
            sessionId, proofKind: 'provider_activity', observedAtMs: 1_000,
            serviceId: classification.serviceId, profileId: 'primary', groupId: null,
          });
        }
        return { status: 'no_eligible_member', groupExhausted: true, retryAtMs: 5_000, excluded: [] };
      },
    });
    try {
      const attempt = await scheduler.beginClassifiedFailure({
        reportId: 'manual-proof-report', sessionId, switchesThisTurn: 0, classification,
      });
      if (attempt.status !== 'scheduled') throw new Error('Expected a scheduled recovery attempt');
      expect(attempt.attemptId).toBeTruthy();
      await expect(checkRuntimeAuthUsageLimitRecovery({
        scheduler, sessionId, attemptId: attempt.attemptId!,
      })).resolves.toEqual({ ok: true, status: publishProof ? 'resumed' : 'waiting' });
      expect(scheduler.readForSession(sessionId)).toEqual([
        expect.objectContaining({ attemptId: attempt.attemptId, status: publishProof ? 'recovered' : 'waiting' }),
      ]);
    } finally {
      scheduler.dispose();
    }
  });
});
