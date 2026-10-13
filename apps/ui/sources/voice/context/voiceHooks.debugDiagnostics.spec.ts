import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { settingsParse } from '@/sync/domains/settings/settings';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

installDisconnectedServerSocketBoundary();
vi.stubEnv('PUBLIC_EXPO_DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING', '1');

const { storage } = await import('@/sync/domains/state/storage');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
const { registerVoiceAdapters, resetVoiceAdapterRegistryForTests } = await import('@/voice/session/voiceAdapterRegistry');
const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
const { voiceHooks } = await import('./voiceHooks');

const address = { serverId: getActiveServerSnapshot().serverId, sessionId: 's1' };
const delivered: string[] = [];
afterAll(() => vi.unstubAllEnvs());

function collectConsoleOutput(calls: unknown[][]): string {
  return calls.flatMap((call) => call.map((arg) => {
    if (typeof arg === 'string') return arg;
    try { return JSON.stringify(arg); } catch { return String(arg); }
  })).join('\n');
}

describe('voiceHooks debug diagnostics', () => {
  beforeEach(() => {
    voiceHooks.onVoiceStopped();
    delivered.length = 0;
    const snapshot = { adapterId: 'test.diagnostics', sessionId: 'voice-control', status: 'connected' as const, mode: 'idle' as const, canStop: true };
    resetVoiceAdapterRegistryForTests();
    // Only the provider output transport is synthetic; context formatting,
    // privacy, targets, adapter selection and sink composition stay real.
    registerVoiceAdapters([{
      id: snapshot.adapterId, engineKind: 'realtime', start: async () => {}, stop: async () => {},
      toggle: async () => {}, interrupt: async () => {}, setMuted: async () => {}, sendContextUpdate: () => {},
      getSnapshot: () => snapshot,
      resolveContextChannel: () => ({ hostAuthoredContext: 'session_context',
        sendContextualUpdate: (text) => { delivered.push(text); },
        sendTextMessage: (text) => { delivered.push(text); },
      }),
    }]);
    setVoiceSessionSnapshot(snapshot);
    storage.setState({ settings: settingsParse({ voice: {
      privacy: { shareSessionSummary: true, shareRecentMessages: true },
      ui: { updates: { activeSession: 'snippets' } },
    } }), sessions: { s1: createSessionFixture({ id: 's1', serverId: address.serverId,
      metadata: { ...createSessionFixture().metadata!, summary: { text: 'TOP_SECRET_CONTEXT', updatedAt: 1 } },
    }) } });
    useVoiceTargetStore.getState().setPrimaryActionSessionAddress(address);
    useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([address]);
  });

  afterEach(() => {
    voiceHooks.onVoiceStopped();
    resetVoiceAdapterRegistryForTests();
    setVoiceSessionSnapshot({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
    vi.restoreAllMocks();
  });

  it('emits safe diagnostics without logging raw voice context payloads', () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    voiceHooks.onReady(address);
    const output = collectConsoleOutput([...consoleLogSpy.mock.calls, ...consoleDebugSpy.mock.calls]);
    expect(delivered.join('\n')).toContain('TOP_SECRET_CONTEXT');
    expect(output).toContain('voice_contextual_update');
    expect(output).not.toContain('TOP_SECRET_CONTEXT');
  });

  it('retires the released tracked-target presentation with the Voice attempt', () => {
    expect(useVoiceTargetStore.getState().voiceLiveContextSessionAddresses).toEqual([address]);
    voiceHooks.onVoiceStopped();
    expect(useVoiceTargetStore.getState().voiceLiveContextSessionAddresses).toEqual([]);
  });
});
