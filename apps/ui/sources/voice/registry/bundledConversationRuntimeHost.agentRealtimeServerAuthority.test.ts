import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture } from '@/dev/testkit';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const network = await installSessionOpsNetworkBoundary();
let homeA: Awaited<ReturnType<typeof network.addHome>>;
let homeB: Awaited<ReturnType<typeof network.addHome>>;
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { bindVoiceRuntimeAttemptBinding, createVoiceRuntimeAttemptBindingOwner, voiceSessionBindingStore } =
  await import('@/voice/binding/voiceConversationBindingStore');
const { createBundledConversationRuntimeHostLease } = await import('./bundledConversationRuntimeHost');

const PROVIDER = Object.freeze({ pluginId: 'happier.agent.codex', localId: 'realtime-codex' });
const AGENT = Object.freeze({ pluginId: 'happier.agent.codex', localId: 'codex' });
const ADAPTER_ID = 'happier.agent.codex/realtime-codex';
const SESSION_ID = 'agent-realtime-server-authority-session';
const initialSessions = storage.getState().sessions;

function agentSessionOn(serverId: string) {
  return createSessionFixture({ id: SESSION_ID, active: true, serverId, encryptionMode: 'plain',
    metadata: { path: '/Users/tester/project', host: 'tester.local', flavor: 'codex' } });
}

function installSessionOn(serverId: string): void {
  storage.setState({ sessions: { [SESSION_ID]: agentSessionOn(serverId) } });
}

afterAll(async () => {
  await network.dispose();
  storage.setState({ sessions: initialSessions });
});

describe('Agent-realtime voice RPCs keep the server they were bound to', () => {
  beforeEach(async () => {
    network.resetRequests();
    homeA = await network.addHome('https://voice-authority-a.example.test', 'account-a');
    homeB = await network.addHome('https://voice-authority-b.example.test', 'account-b');
    const sessionsA = createSessionMetadataHttpBoundary(() => ({ [SESSION_ID]: agentSessionOn(homeA.id) }));
    const sessionsB = createSessionMetadataHttpBoundary(() => ({ [SESSION_ID]: agentSessionOn(homeB.id) }));
    network.setHttpResponder(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
      return (url.origin === homeA.serverUrl ? sessionsA : sessionsB).handle(input, init);
    });
    // Daemon replies are delivered by Socket.IO, below real saved-Home admission,
    // Account credentials, Session crypto selection and scoped RPC framing.
    network.setRpcResponder(async request => {
      switch (request.method) {
        case 'session.agentRealtime.inspect': return { ok: true, status: 'available', transport: 'webrtc' };
        case 'session.agentRealtime.start': return { ok: true, status: 'started',
          transport: { kind: 'webrtc', answerSdp: 'v=0' } };
        case 'session.agentRealtime.stop': return { ok: true, status: 'stopped' };
        case 'session.agentRealtime.watch': return await new Promise(() => {});
        default: throw new Error(`Unexpected RPC: ${request.method}`);
      }
    });
    voiceSessionBindingStore.setState({ runtimeBindingsByConversationSessionId: {}, persistedBindingsByConversationSessionId: {} });
    storage.setState({ sessions: {} });
  });

  it('inspects the session on its own server rather than whichever server is active', async () => {
    installSessionOn(homeA.id);
    const lease = createBundledConversationRuntimeHostLease();
    try {
      await lease.host.resolveAgentRealtimeVoiceConversationBinding!({
        provider: PROVIDER, agent: AGENT, controlSessionId: SESSION_ID,
        requestedTargetSessionAddress: { serverId: homeA.id, sessionId: SESSION_ID }, settings: {},
      });
    } finally {
      lease.revoke();
    }
    expect(network.requests).toEqual([expect.objectContaining({ targetId: SESSION_ID,
      method: 'session.agentRealtime.inspect', serverUrl: homeA.serverUrl, token: homeA.token })]);
  });

  it('retires an unanswered inspection when its runtime is revoked', async () => {
    installSessionOn(homeA.id);
    network.setRpcResponder(async () => await new Promise(() => {}));
    const lease = createBundledConversationRuntimeHostLease();
    const reading = lease.host.resolveAgentRealtimeVoiceConversationBinding!({
      provider: PROVIDER, agent: AGENT, controlSessionId: SESSION_ID,
      requestedTargetSessionAddress: { serverId: homeA.id, sessionId: SESSION_ID }, settings: {},
    }).then(() => 'settled', () => 'settled');
    await network.waitForRpcRequest(request => request.method === 'session.agentRealtime.inspect');
    expect(network.requests.some(request => request.method === 'session.agentRealtime.inspect')).toBe(true);
    lease.revoke();
    expect(await reading).toBe('settled');
  });

  it('keeps start, watch and cleanup stop on the server captured when the attempt bound', async () => {
    installSessionOn(homeA.id);
    bindVoiceRuntimeAttemptBinding({ owner: createVoiceRuntimeAttemptBindingOwner(), binding: {
      adapterId: ADAPTER_ID, controlSessionId: SESSION_ID, conversationSessionId: SESSION_ID,
      conversationSessionAddress: { serverId: homeA.id, sessionId: SESSION_ID },
      lifetime: 'runtime_attempt', transcriptMode: 'native_session', targetSessionAddress: null, updatedAt: 1,
    } });
    const lease = createBundledConversationRuntimeHostLease();
    const attempt = new AbortController();
    try {
      const service = await lease.host.createAgentSessionRealtimeService!({
        provider: PROVIDER, agent: AGENT, adapterId: ADAPTER_ID, controlSessionId: SESSION_ID,
        applicationAttemptId: 'attempt-1', signal: attempt.signal, onStarted: () => {},
      });
      if (!service) throw new Error('Agent realtime service was not created');
      installSessionOn(homeB.id);
      const started = await service.start({ transport: { kind: 'webrtc', offerSdp: 'v=0' } });
      if (started.status !== 'started') throw new Error(`Agent realtime start did not start: ${started.status}`);
      await started.handle.stop();
    } finally {
      attempt.abort();
      lease.revoke();
    }
    expect(network.requests.map(request => request.method).sort()).toEqual([
      'session.agentRealtime.start', 'session.agentRealtime.stop', 'session.agentRealtime.watch',
    ]);
    for (const request of network.requests) {
      expect(request).toMatchObject({ targetId: SESSION_ID, serverUrl: homeA.serverUrl, token: homeA.token });
    }
  });
});
