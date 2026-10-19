import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRuntimeIssueV1, SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { continueAccountQualifiedSessionAfterUsageLimitReset, continueSessionAfterUsageLimitReset } from './continueSessionAfterUsageLimitReset';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { createSessionConnectedServiceRuntimeAuthRefreshHandler } from '../sessionRuntimeAuthRefresh';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';
import { readQualifiedConnectedAccountCredentialMaterial } from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import type { ConnectedServiceRuntimeFailureClassification } from '../runtimeAuth/types';

// HTTP is the process boundary. Keep issue validation, continuation identity,
// Session authoring, envelopes and ordinary Pending transport real.
const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('axios', () => ({ default: { ...http, isAxiosError: () => false } }));

const sessionId = 'c123456789012345678901234';
const serviceId = 'happier.agent.claude/claude-subscription';
const credentials = { token: 'quota-recovery-test', encryption: null };
const issue: SessionRuntimeIssueV1 = {
  v: 1, scope: 'primary_session', status: 'failed', code: 'usage_limit', source: 'usage_limit',
  agentId: 'claude', agentTurnId: 'interrupted-turn', occurredAt: 100,
  usageLimit: { v: 1, resetAtMs: 200, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait',
    connectedService: { serviceId, profileId: 'account-1', groupId: null } },
};
const recovery: SessionUsageLimitRecoveryV1 = {
  v: 1, status: 'waiting', issueFingerprint: 'recovery-attempt', runtimeAuthRecoveryAttemptId: 'recovery-attempt',
  armedAtMs: 110, resetAtMs: 200, nextCheckAtMs: 200, attemptCount: 0, maxAttempts: 3,
  lastProbeError: null, resumePromptMode: 'standard',
  selectedAuth: { kind: 'profile', serviceId, profileId: 'account-1' },
};

function fixture(overrides: Partial<RawSessionRecord> = {}) {
  const selectedAuth = { ...recovery.selectedAuth, retiredSelectionField: true };
  const fixtureRecovery: SessionUsageLimitRecoveryV1 = { ...recovery, selectedAuth };
  const metadata = {
    connectedServices: { v: 2, retiredBindingsField: true, bindingsByServiceId: {
      [serviceId]: { source: 'connected', selection: 'profile', profileId: 'account-1', retiredBindingField: true },
    } },
    sessionUsageLimitRecoveryV1: { ...fixtureRecovery, retiredRecoveryField: true },
  };
  const rawSession = createSessionRecordFixture({
    id: sessionId, active: true, encryptionMode: 'plain', metadata: JSON.stringify(metadata),
    latestTurnId: 'canonical-failed-turn', latestTurnStatus: 'failed', lastRuntimeIssue: issue,
    ...overrides,
  });
  http.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
    } };
    if (url.includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: rawSession } };
    throw new Error(`Unexpected read: ${url}`);
  });
  return { credentials, sessionId, rawSession, metadata, recovery, nowMs: 200, isCurrent: () => true };
}

describe('continueSessionAfterUsageLimitReset', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    http.post.mockResolvedValue({ status: 200, data: { didWrite: true, terminal: false } });
  });

  it.each([true, false])('admits an ordinary send-now continuation with active projection=%s', async (active) => {
    const input = fixture({ active });
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'continued' });
    expect(http.post).toHaveBeenCalledWith(expect.stringContaining(`/v2/sessions/${sessionId}/pending`),
      expect.objectContaining({ localId: expect.stringMatching(/^connected-service-continuation:/),
        deliveryMode: 'continuation_if_no_queued_user_input', requestedAction: { v: 1, kind: 'send_now' },
        content: { t: 'plain', v: expect.objectContaining({ role: 'user', content: {
          type: 'text', text: 'Usage limits are lifted. Continue where you left off.',
        } }) },
      }), expect.anything());
    expect(http.post).toHaveBeenCalledOnce();
  });

  it.each([true, false])('settles an accepted auth refresh during Pending admission only for the same known quota subject (known=%s)', async (knownSubject) => {
    const continuation = fixture();
    const revisionA = 'csr_0123456789ABCDEFGHJKMNPQRS';
    const revisionB = 'csr_ZYXWVUTSRQPONMLKJHGFEDCBA1';
    let storedRevision = revisionA;
    const registry = new ConnectedServiceRuntimeRegistry();
    registry.registerTarget({
      pid: 123, agentId: 'claude', sessionId, materializationKey: 'continuation-refresh-test',
      connectedServicesBindingsRaw: continuation.metadata.connectedServices,
      connectedServiceSelectionsEnv: { [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
        kind: 'profile', serviceId, profileId: 'account-1', credentialRevision: revisionA,
      }]) },
    });
    const read = http.get.getMockImplementation()!;
    http.get.mockImplementation(async (url: string) => url.includes('/v4/connect/qualified/credential')
      ? { status: 200, data: {
        ref: { service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, accountId: 'account-1' },
        authenticationModeId: 'oauth', revisionSemantics: 'revisioned', credentialRevision: storedRevision,
        configurationRevision: null, metadata: { scopes: [] },
        content: { t: 'plain', v: { v: 1, values: { accessToken: 'test-token', providerAccountId: 'quota-subject' } } },
      } } : read(url));
    const readAccount = async () => {
      const material = await readQualifiedConnectedAccountCredentialMaterial({
        credentials, account: { service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, accountId: 'account-1' },
        getAccountEncryptionMode: async () => 'plain',
      });
      return material ? { providerAccountId: material.credential.values.providerAccountId ?? null,
        credentialRevision: material.snapshot.credentialRevision } : null;
    };
    // The plugin process/credential bridge is the only refresh boundary fixture.
    const refresh = createSessionConnectedServiceRuntimeAuthRefreshHandler({ registry,
      resolveDaemonAuthBridge: async () => ({ registration: { serviceId, refresh: async () => {
        storedRevision = revisionB;
        return { status: 'refreshed', result: { credentialRevision: revisionB } };
      } } }),
    });
    const account = await readAccount();
    if (!account) throw new Error('Expected qualified account fixture');
    http.post.mockImplementation(async () => {
      expect(await refresh({ sessionId, refreshAttemptId: 'accepted-during-pending',
        selection: { kind: 'profile', serviceId, profileId: 'account-1' }, expectedCredentialRevision: revisionA }))
        .toMatchObject({ ok: true, result: { status: 'refreshed' } });
      expect(registry.getBySessionId(sessionId)?.activeBindings[0]?.credentialRevision).toBe(revisionB);
      return { status: 200, data: { didWrite: true, terminal: false } };
    });
    const classification: ConnectedServiceRuntimeFailureClassification = {
      kind: 'usage_limit', limitCategory: 'usage_limit', serviceId, profileId: 'account-1', groupId: null,
      resetsAtMs: 200, retryAfterMs: null, quotaScope: 'account', providerLimitId: null,
      action: null, planType: null, rateLimits: null, source: 'structured_provider_error',
      expectedCredentialRevision: revisionA, ...(knownSubject ? { sourceProviderAccountId: 'quota-subject' } : {}),
    };
    const result = await continueAccountQualifiedSessionAfterUsageLimitReset({
      continuation, classification, readAccount,
      readActiveBinding: () => registry.getBySessionId(sessionId)?.activeBindings.find((binding) => binding.serviceId === serviceId),
    });
    expect(http.post).toHaveBeenCalledOnce();
    expect(result).toEqual(knownSubject
      ? { status: 'continuation_enqueued', credentialRevision: revisionB }
      : { status: 'recovery_superseded' });
  });

  it('does not admit an attempt cancelled during Session lookup', async () => {
    const input = fixture();
    let current = true;
    const read = http.get.getMockImplementation()!;
    http.get.mockImplementation(async (...args: unknown[]) => {
      const result = await read(...args);
      if (String(args[0]).includes(`/v2/sessions/${sessionId}`)) current = false;
      return result;
    });
    expect(await continueSessionAfterUsageLimitReset({ ...input, isCurrent: () => current }))
      .toEqual({ status: 'superseded' });
    expect(http.post).not.toHaveBeenCalled();
  });

  it.each([
    { latestTurnStatus: 'completed' as const },
    { latestTurnId: 'newer-canonical-turn' },
    { lastRuntimeIssue: { ...issue, agentTurnId: 'newer-turn', occurredAt: 120 } },
    { lastRuntimeIssue: { ...issue, usageLimit: { ...issue.usageLimit!, connectedService: {
      serviceId, profileId: 'account-2', groupId: null,
    } } } },
  ])('suppresses newer turn or account evidence found at admission: %j', async (fresh) => {
    const input = fixture();
    const read = http.get.getMockImplementation()!;
    http.get.mockImplementation(async (url: string) => url.includes(`/v2/sessions/${sessionId}`)
      ? { status: 200, data: { session: { ...input.rawSession, ...fresh } } } : read(url));
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'suppressed' });
    expect(http.post).not.toHaveBeenCalled();
  });

  it('retains one Pending identity across retry without reconstructing the interrupted input', async () => {
    const input = fixture();
    await continueSessionAfterUsageLimitReset(input);
    http.post.mockResolvedValueOnce({ status: 200, data: { didWrite: false, terminal: false } });
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'continued' });
    expect(http.post.mock.calls[1]?.[1]).toEqual(http.post.mock.calls[0]?.[1]);
  });

  it('honors atomic Pending suppression when user input is queued', async () => {
    const input = fixture();
    http.post.mockResolvedValue({ status: 200, data: { didWrite: false, terminal: false, suppressed: true } });
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'suppressed' });
  });

  it('keeps the owner prompt mode when its fresh projection has not caught up', async () => {
    const input = fixture();
    const currentRecovery = { ...recovery, resumePromptMode: 'custom' as const };
    input.metadata.sessionUsageLimitRecoveryV1 = { ...input.metadata.sessionUsageLimitRecoveryV1, ...recovery, resumePromptMode: 'off' };
    const read = http.get.getMockImplementation()!;
    const freshMetadata = { ...input.metadata, sessionUsageLimitRecoveryV1: { ...recovery, resumePromptMode: 'off' } };
    http.get.mockImplementation(async (url: string) => url.includes(`/v2/sessions/${sessionId}`)
      ? { status: 200, data: { session: { ...input.rawSession, metadata: JSON.stringify(freshMetadata) } } } : read(url));
    expect(await continueSessionAfterUsageLimitReset({ ...input, recovery: currentRecovery,
      customResumePrompt: 'Continue from the authoritative custom mode' })).toEqual({ status: 'continued' });
    expect(http.post.mock.calls[0]?.[1]).toMatchObject({ content: { t: 'plain', v: { content: {
      type: 'text', text: 'Continue from the authoritative custom mode',
    } } } });
  });

  it('does not continue after the qualified Session account binding changes', async () => {
    const input = fixture();
    input.metadata.connectedServices.bindingsByServiceId[serviceId]!.profileId = 'replacement-account';
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'superseded' });
    expect(http.post).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'exhausted', 'paused'] as const)('does not revive a terminal owned attempt: %s', async (status) => {
    const input = fixture();
    expect(await continueSessionAfterUsageLimitReset({ ...input, recovery: { ...recovery, status } }))
      .toEqual({ status: 'superseded' });
    expect(http.post).not.toHaveBeenCalled();
  });

  it('freezes custom continuation text before Pending custody', async () => {
    const input = fixture();
    const customRecovery = { ...recovery, resumePromptMode: 'custom' as const };
    input.metadata.sessionUsageLimitRecoveryV1 = { ...input.metadata.sessionUsageLimitRecoveryV1, ...customRecovery };
    await continueSessionAfterUsageLimitReset({ ...input, recovery: customRecovery,
      customResumePrompt: 'Resume the interrupted work' });
    expect(http.post.mock.calls[0]?.[1]).toMatchObject({ content: { t: 'plain', v: { content: {
      type: 'text', text: 'Resume the interrupted work',
    } } } });
  });

  it('does not report continued when Pending acceptance is unknown', async () => {
    const input = fixture();
    http.post.mockRejectedValue(new Error('acknowledgement lost'));
    await expect(continueSessionAfterUsageLimitReset(input)).rejects.toThrow('continuation_prompt_send_failed:timeout');
  });

  it('preserves already-admitted input when cancellation follows acceptance', async () => {
    const input = fixture();
    let current = true;
    http.post.mockImplementation(async () => {
      current = false;
      return { status: 200, data: { didWrite: true, terminal: false } };
    });
    const run = () => continueSessionAfterUsageLimitReset({ ...input, isCurrent: () => current });
    expect(await run()).toEqual({ status: 'superseded' });
    expect(await run()).toEqual({ status: 'superseded' });
    expect(http.post).toHaveBeenCalledOnce();
  });

  it('uses the canonical failed turn when the issue has no native turn id', async () => {
    const input = fixture({ lastRuntimeIssue: { ...issue, agentTurnId: undefined } });
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'continued' });
  });

  it('does not resurrect an old issue after a completed turn', async () => {
    expect(await continueSessionAfterUsageLimitReset(fixture({ latestTurnStatus: 'completed' })))
      .toEqual({ status: 'superseded' });
    expect(http.post).not.toHaveBeenCalled();
  });

  it('waits until the reset and honors disabled continuation', async () => {
    const input = fixture();
    expect(await continueSessionAfterUsageLimitReset({ ...input, nowMs: 199 })).toEqual({ status: 'not_ready' });
    expect(await continueSessionAfterUsageLimitReset({ ...input, recovery: { ...recovery, resumePromptMode: 'off' } }))
      .toEqual({ status: 'disabled' });
    const unownedRecovery = { ...recovery, runtimeAuthRecoveryAttemptId: undefined };
    input.metadata.sessionUsageLimitRecoveryV1 = { ...input.metadata.sessionUsageLimitRecoveryV1, ...unownedRecovery, resumePromptMode: 'off' };
    expect(await continueSessionAfterUsageLimitReset({ ...input, recovery: unownedRecovery }))
      .toEqual({ status: 'disabled' });
    expect(http.post).not.toHaveBeenCalled();
  });
});
