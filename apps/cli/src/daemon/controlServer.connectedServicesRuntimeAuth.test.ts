import { describe, expect, it } from 'vitest';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';
import { createDaemonControlApp } from './controlServer';
import { RuntimeAuthRecoveryScheduler } from './connectedServices/runtimeAuth/RuntimeAuthRecoveryScheduler';
import { handleConnectedServiceRuntimeAuthFailure } from './connectedServices/runtimeAuth/handleConnectedServiceRuntimeAuthFailure';
import type { ConnectedServiceRuntimeFailureClassification } from './connectedServices/runtimeAuth/types';
import { ConnectedServiceAuthGroupSwitchCoordinator, InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry } from './connectedServices/accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import { ConnectedServiceRuntimeRegistry } from './connectedServices/runtimeRegistry/registry';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from './connectedServices/connectedServiceChildEnvironment';
import { authorizeConnectedServiceRuntimeAuthFailureSource } from './connectedServices/runtimeAuth/handleConnectedServiceRuntimeAuthFailureForSession';
import { readConnectedServiceRuntimeAuthFailureSourceBinding } from './connectedServices/runtimeAuth/handleConnectedServiceRuntimeAuthFailure';
import { resolveRoutedUsageLimitRecoveryResumePromptMode } from '@/session/usageLimitRecoveryControls/resolveRoutedUsageLimitRecoveryResumePromptMode';

describe('registered runtime-auth failure recovery', () => {
  it('resolves group continuation policy after evidence-only Session failure receives its current binding', async () => {
    const serviceId = 'happier.agent.claude/claude-subscription';
    const tracked = { startedBy: 'daemon' as const, pid: 222, happySessionId: 'evidence-session', spawnOptions: { directory: '/project' } };
    const registry = new ConnectedServiceRuntimeRegistry();
    registry.registerTarget({ pid: tracked.pid, sessionId: tracked.happySessionId, agentId: 'claude',
      connectedServicesBindingsRaw: { v: 2, bindingsByServiceId: { [serviceId]: { source: 'connected', selection: 'group', groupId: 'current-pool' } } },
      connectedServiceSelectionsEnv: { [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{ kind: 'group', serviceId,
        groupId: 'current-pool', activeProfileId: 'current-member', fallbackProfileId: 'old', generation: 7,
        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' }]) } });
    const unexpectedGroupEffect = async (): Promise<never> => { throw new Error('Capacity must not switch Accounts'); };
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({ leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000, quotaFreshnessMs: 60_000, loadState: unexpectedGroupEffect, commitSwitch: unexpectedGroupEffect, applyGeneration: unexpectedGroupEffect });
    const app = createDaemonControlApp({ getChildren: () => [tracked], machineId: 'machine', controlToken: 'token',
      stopSession: async () => ({ status: 'not_found' }),
      spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {},
      authorizeConnectedServiceRuntimeAuthFailure: input => authorizeConnectedServiceRuntimeAuthFailureSource({ ...input, getChildren: () => [tracked],
        resolveRegisteredRuntimeAuthFailureSource: async () => readConnectedServiceRuntimeAuthFailureSourceBinding(registry.getBySessionId(tracked.happySessionId)!, serviceId) }),
      resolveConnectedServiceRuntimeAuthResumePromptMode: ({ classification, explicit }) => resolveRoutedUsageLimitRecoveryResumePromptMode({ explicit,
        accountSettings: { resumePromptMode: 'standard' },
        loadGroupPolicy: async () => classification.groupId === 'current-pool' ? { resumePromptMode: 'off' } : null }),
      handleConnectedServiceRuntimeAuthFailure: input => handleConnectedServiceRuntimeAuthFailure({ ...input,
        selection: registry.getBySessionId(tracked.happySessionId)!.connectedServiceSelections[0]!, switchCoordinator: coordinator }),
    });
    try {
      const response = await app.inject({ method: 'POST', url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' }, payload: { sessionId: tracked.happySessionId,
          classification: { kind: 'capacity', serviceId, profileId: null, groupId: null, limitCategory: 'capacity', quotaScope: 'provider',
            resetsAtMs: null, planType: null, rateLimits: null, source: 'structured_provider_error' } } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true, resumePromptMode: 'off' });
    } finally { await app.close(); }
  });
  it('arms the exact token-qualified profile quota attempt through the registered failure route', async () => {
    const nowMs = Date.now();
    const resetAtMs = nowMs + 60_000;
    const unexpectedGroupEffect = async (): Promise<never> => { throw new Error('Unexpected group recovery effect'); };
    const switchCoordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(), nowMs: () => nowMs,
      quotaFreshnessMs: 60_000, loadState: unexpectedGroupEffect,
      commitSwitch: unexpectedGroupEffect, applyGeneration: unexpectedGroupEffect,
    });
    const recover = async (input: Readonly<{ sessionId: string; classification: ConnectedServiceRuntimeFailureClassification; switchesThisTurn: number }>) =>
      await handleConnectedServiceRuntimeAuthFailure({ ...input,
        selection: { kind: 'profile', serviceId: input.classification.serviceId, profileId: 'primary' },
        switchCoordinator,
      });
    const scheduler = new RuntimeAuthRecoveryScheduler({ nowMs: () => nowMs, jitterMs: () => 0, recover });
    const app = createDaemonControlApp({
      getChildren: () => [], machineId: 'machine', stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'token',
      runtimeAuthRecoveryScheduler: scheduler, handleConnectedServiceRuntimeAuthFailure: recover,
    });
    try {
      const response = await app.inject({ method: 'POST', url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' }, payload: {
          reportId: 'runtime-auth-report:qualified-profile-quota', sessionId: 'qualified-profile-quota',
          classification: { kind: 'usage_limit', serviceId: 'happier.agent.codex/openai-codex',
            profileId: 'primary', groupId: null, quotaScope: 'account', resetsAtMs: resetAtMs,
            sourceProviderAccountId: 'same-provider-account', failingAccessTokenFingerprint: 'quota-token-fingerprint',
            expectedCredentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa', planType: null, rateLimits: null,
            source: 'structured_provider_error' },
        } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true, recoveryReceipt: {
        attemptId: 'runtime-auth-attempt:qualified-profile-quota',
      } });
      expect(scheduler.readForSession('qualified-profile-quota')).toEqual([
        expect.objectContaining({ status: 'waiting', nextRetryAtMs: resetAtMs, attemptCount: 1,
          attemptId: 'runtime-auth-attempt:qualified-profile-quota', classification: expect.objectContaining({
            failingAccessTokenFingerprint: 'quota-token-fingerprint',
          }) }),
      ]);
    } finally { scheduler.dispose(); await app.close(); }
  });
});
