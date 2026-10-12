import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));

import { PLUGIN_MANIFEST } from '../../manifest.js';
import {
  ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
} from '../../protocol/voice/index.js';
import { activate, createElevenLabsVoiceProviderRuntime, VOICE_PROVIDER_PRESENTATIONS } from './index.js';

describe('ElevenLabs bundled voice UI presentation', () => {
  const presentation = VOICE_PROVIDER_PRESENTATIONS[0]!;

  it('keeps semantic ownership in the manifest and presentation qualified', () => {
    expect(PLUGIN_MANIFEST.contributes.voiceProviders[0]).toMatchObject({
      id: 'realtime-elevenlabs',
      roles: ['conversation_stt', 'conversation_tts', 'realtime_conversation', 'turn_control'],
      platforms: ['web', 'ios', 'android'],
    });
    expect(presentation.providerId).toBe('happier.voice.elevenlabs/realtime-elevenlabs');
    expect(presentation).not.toHaveProperty('declaration');
    expect(presentation).not.toHaveProperty('roles');
    expect(presentation).not.toHaveProperty('requirements');
    expect(presentation).not.toHaveProperty('providerSettings');
    expect(presentation).not.toHaveProperty('createSettingsSection');
    expect(PLUGIN_MANIFEST.contributes.voiceProviders[0]?.settings?.presentation)
      .toMatchObject({ kind: 'voice.provider-settings.v1', modes: ['happier', 'byo'] });
  });

  it('keeps released persistence history out of provider presentation', () => {
    expect(presentation).not.toHaveProperty('legacySettingsMigration');
    expect(ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS.tts.voiceId).toBe(
      'hpp4J3VqNfWAUOO0d1Us',
    );
  });

  it('activates the declared runtime through the portable entry', () => {
    const register = vi.fn();
    activate({ voiceProviders: { register } });
    expect(register.mock.calls).toEqual([[
      PLUGIN_MANIFEST.contributes.voiceProviders[0]?.id,
      expect.objectContaining({ kind: 'conversation', microphoneMode: 'provider_managed' }),
    ]]);
  });

  it.each([
    { welcome: { enabled: false, mode: 'immediate' as const, text: 'Bonjour.' }, firstMessage: '' },
    { welcome: { enabled: true, mode: 'on_first_turn' as const, text: 'Bonjour.' }, firstMessage: '' },
    { welcome: { enabled: true, mode: 'immediate' as const, text: 'Bonjour, je vous écoute — que souhaitez-vous faire ?' }, firstMessage: 'Bonjour, je vous écoute — que souhaitez-vous faire ?' },
    { welcome: { enabled: true, mode: 'immediate' as const }, firstMessage: '' },
  ])('preserves native literal greeting policy through the portable entry %j', async ({ welcome, firstMessage }) => {
    const runtime = createElevenLabsVoiceProviderRuntime();
    const prepared = await runtime.protocol.prepare({
      controlSessionId: 'native-greeting', attemptId: 1, reason: 'initial',
      request: { initialContext: 'Authorized workspace context.' }, platform: 'ios',
      providerConfig: ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
      credentials: { phase: 'prepare', mediated: null, raw: null },
      providerConversation: null,
      hostedConversation: {
        start: async () => ({ allowed: true, token: 'ephemeral-token', leaseId: 'lease-native', bindingNonce: 'nonce-native', expiresAtMs: null }),
        complete: async () => {}, abort: async () => {},
      },
      attemptPolicy: { instructions: 'Reply in French using the admitted tools.', assistantLanguage: 'fr-FR', welcome },
      signal: new AbortController().signal,
    });
    expect(prepared).toMatchObject({ kind: 'prepared', session: {
      initialContextDelivery: 'prepared',
      config: {
        overrides: { agent: { firstMessage, language: 'fr', prompt: { prompt: expect.stringContaining('{{initialConversationContext}}') } } },
        dynamicVariables: { initialConversationContext: 'Authorized workspace context.' },
      },
    } });
    expect(prepared).toMatchObject({ session: { config: { overrides: { agent: {
      prompt: { prompt: expect.stringContaining('Reply in French using the admitted tools.') },
    } } } } });
    await runtime.dispose?.();
  });
});
