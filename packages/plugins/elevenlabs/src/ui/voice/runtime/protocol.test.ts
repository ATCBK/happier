import { describe, expect, it, vi } from 'vitest';

import { ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS, ElevenLabsVoiceProviderSettingsSchema } from '../../../protocol/voice/index.js';
import { createElevenLabsProtocolAdapter } from './protocol.js';
import { createElevenLabsEventMapper } from './eventMapper.js';
import { createElevenLabsSessionLifecycle } from './sessionLifecycle.js';
import { createElevenLabsSessionPreparationService } from './sessionPreparation.js';

function createProtocolFixture() {
  // Hosted admission/settlement is the service boundary. Preparation, config
  // parsing, event mapping and attempt custody remain the real provider owners.
  let leaseIndex = 0;
  const hostedConversation = {
    start: vi.fn(async () => ({
      allowed: true as const,
      leaseId: `lease-${++leaseIndex}`,
      bindingNonce: 'binding-nonce',
      token: 'ephemeral-token',
      expiresAtMs: 123456,
    })),
    complete: vi.fn(async (_input: Readonly<{ providerConversationId: string }>) => undefined),
    abort: vi.fn(async () => undefined),
  };
  const hostedByLease = new Map<string, typeof hostedConversation>();
  const preparation = createElevenLabsSessionPreparationService({
    providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
    projectVoiceSettings: (providerConfig) => ({
      providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
      assistantLanguage: null,
      providerConfig: ElevenLabsVoiceProviderSettingsSchema.parse(providerConfig),
    }),
    alert: () => {},
  });
  const lifecycle = createElevenLabsSessionLifecycle({
    takeHostedConversation: (leaseId) => hostedByLease.get(leaseId) ?? null,
    forgetHostedConversation: (leaseId) => { hostedByLease.delete(leaseId); },
  });
  const runtime = createElevenLabsProtocolAdapter({
    preparation,
    lifecycle,
    eventMapper: createElevenLabsEventMapper(),
    onDiagnosticError: (reason) => { throw new Error(reason); },
    rememberHostedConversation: (leaseId) => { hostedByLease.set(leaseId, hostedConversation); },
  });
  const prepare = (controlSessionId: string, attemptId: number, request: Readonly<{
    initialContext?: string; requestedTargetSessionId?: string; textOnly?: boolean;
  }> = {}) => runtime.adapter.prepare({
    controlSessionId,
    attemptId,
    reason: 'initial',
    request,
    platform: 'web',
    providerConfig: ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
    credentials: { phase: 'prepare', mediated: null, raw: null },
    providerConversation: null,
    hostedConversation,
    signal: new AbortController().signal,
  });
  return { runtime, prepare, hostedConversation };
}

describe('createElevenLabsProtocolAdapter', () => {
  it('maps controller preparation into provider-owned session config and lifecycle metadata', async () => {
    const { runtime, prepare, hostedConversation } = createProtocolFixture();
    await expect(prepare('control-1', 1, {
      initialContext: 'context',
      requestedTargetSessionId: 'target-1',
      textOnly: false,
    })).resolves.toMatchObject({
      kind: 'prepared',
      session: {
        config: {
          conversationToken: 'ephemeral-token',
          textOnly: false,
          dynamicVariables: { sessionId: 'control-1', initialConversationContext: 'context' },
        },
        initialContextDelivery: 'prepared',
        safeMetadata: { billingMode: 'happier', expiresAtMs: 123456 },
      },
    });
    expect(hostedConversation.start).toHaveBeenCalledWith({ sessionId: 'target-1' });

    await prepare('control-1', 2, {
      initialContext: 'replacement context',
      requestedTargetSessionId: 'target-1',
      textOnly: false,
    });
    await runtime.adapter.releasePrepared?.({ controlSessionId: 'control-1', attemptId: 1, reason: { code: 'replaced' } });
    // Replacement retires the prior lease; a delayed prior release cannot
    // retire the current attempt or attach its identity to the old lease.
    expect(hostedConversation.abort).toHaveBeenCalledTimes(1);
    runtime.handleSessionIdentity({ controlSessionId: 'control-1', conversationId: 'conversation-1' });
    await runtime.endSession();
    expect(hostedConversation.complete.mock.calls).toEqual([[{ providerConversationId: 'conversation-1' }]]);
    expect(hostedConversation.abort).toHaveBeenCalledTimes(1);
  });

  it('keeps raw ElevenLabs event semantics in the provider leaf and emits canonical transcript events', async () => {
    const { runtime, prepare } = createProtocolFixture();
    await prepare('control-events', 1);
    expect(runtime.adapter.decodeControl({ type: 'elevenlabs.mode', mode: 'speaking' }))
      .toEqual([{ type: 'assistant_output_started' }]);
    expect(runtime.adapter.decodeControl({ type: 'elevenlabs.mode', mode: 'listening' }))
      .toEqual([{ type: 'assistant_output_stopped' }]);
    expect(runtime.adapter.decodeControl({ type: 'elevenlabs.output_audio' })).toEqual([]);
    expect(runtime.adapter.decodeControl({
      type: 'future.provider.event', token: 'sentinel-secret-token', transcript: 'sentinel-private-transcript',
    })).toEqual([]);
    await runtime.endSession();
  });

  it('preserves the exact-message text payload for the SDK connection', () => {
    const { runtime } = createProtocolFixture();
    expect(runtime.adapter.encodeTurnControl('send_exact_message', { text: 'Keep this exact message.' }))
      .toEqual({ type: 'voice.user_text', text: 'Keep this exact message.' });
    expect(runtime.adapter.encodeTurnControl('send_exact_message', {})).toBeNull();
  });

  it('discards prepared provider state when the controller tears down before session identity', async () => {
    const { runtime, prepare, hostedConversation } = createProtocolFixture();
    await prepare('never-connected', 1);
    await runtime.adapter.releasePrepared?.({ controlSessionId: 'never-connected', attemptId: 1, reason: { code: 'error' } });
    runtime.handleSessionIdentity({ controlSessionId: 'never-connected', conversationId: 'late-identity' });
    await runtime.endSession();
    expect(hostedConversation.abort).toHaveBeenCalledTimes(1);
    expect(hostedConversation.complete).not.toHaveBeenCalled();
  });
});
