import { describe, expect, it } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { voiceSettingsParse, readLocalConversationVoiceSettings, writeLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { useBundledConversationProviderSettings } from './useBundledConversationProviderSettings';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';

describe('Work conversation voice source', () => {
  it('retains a bundled catalog after choosing another voice, while preserving other catalog inputs', async () => {
    const providerId = 'happier.voice.elevenlabs/realtime-elevenlabs';
    const entry = createDefaultVoiceProviderRegistry().get(providerId);
    const owner = entry?.providerSettings;
    const tts = owner?.defaultConfig.tts;
    if (!owner || !tts || typeof tts !== 'object' || Array.isArray(tts)) throw new Error('ElevenLabs settings missing');
    const withVoice = (voiceId: string, modelId: string | null = null) => voiceSettingsParse({ providerId, providers: {
      [providerId]: { schemaVersion: owner.schemaVersion,
        config: { ...owner.defaultConfig, tts: { ...tts, voiceId, modelId } } },
    } });
    const hook = await renderHook(voice => useBundledConversationProviderSettings(voice), { initialProps: withVoice('voice-one') });
    const original = hook.getCurrent().sessionChoice?.targetKey;
    await hook.rerender(withVoice('voice-two'));
    expect(hook.getCurrent().sessionChoice?.targetKey).toBe(original);
    await hook.rerender(withVoice('voice-two', 'eleven_multilingual_v2'));
    expect(hook.getCurrent().sessionChoice?.targetKey).not.toBe(original);
    // The first persisted selection of an otherwise default config must keep its known names.
    const defaults = voiceSettingsParse({ providerId });
    await hook.rerender(defaults);
    const defaultTarget = hook.getCurrent().sessionChoice?.targetKey;
    await hook.rerender(withVoice('voice-three'));
    expect(hook.getCurrent().sessionChoice?.targetKey).toBe(defaultTarget);
  });

  it('scopes the catalog to the selected provider credential reference, not unrelated credentials', async () => {
    const binding = { contribution: { pluginId: 'happier.voice.openai', localId: 'realtime-openai' },
      credentialSlotId: 'api_key', credentialSource: { kind: 'savedSecret' },
      credentialBindings: { account: { api_key: 'secret-one' } } };
    const voice = voiceSettingsParse({ providerId: 'happier.voice.openai/realtime-openai', credentialBindings: [binding] });
    const hook = await renderHook(currentVoice => useBundledConversationProviderSettings(currentVoice), { initialProps: voice });
    const original = hook.getCurrent().sessionChoice?.targetKey;
    await hook.rerender(voiceSettingsParse({ ...voice, credentialBindings: [binding, { ...binding,
      contribution: { pluginId: 'happier.voice.google', localId: 'google-cloud-tts' } }] }));
    expect(hook.getCurrent().sessionChoice?.targetKey).toBe(original);
    await hook.rerender(voiceSettingsParse({ ...voice, credentialBindings: [{ ...binding,
      credentialBindings: { account: { api_key: 'secret-two' } } }] }));
    expect(hook.getCurrent().sessionChoice?.targetKey).not.toBe(original);
  });

  it('offers the selected local model voice field while retaining the account agent and model settings', async () => {
    const base = voiceSettingsParse({ providerId: 'local_conversation' });
    const cfg = readLocalConversationVoiceSettings(base);
    const voice = writeLocalConversationVoiceSettings(base, { ...cfg, tts: { ...cfg.tts, provider: 'local_neural',
      localNeural: { ...cfg.tts.localNeural, voiceId: 'af_heart', speed: 1.2 } } });
    const hook = await renderHook(() => useBundledConversationProviderSettings(voice));
    const choice = hook.getCurrent().sessionChoice;
    expect(choice).toMatchObject({ providerId: 'happier.voice.builtin/local-neural',
      providerTitleKey: 'settingsVoice.local.localNeuralTts.provider.title', config: { voiceId: 'af_heart' },
      declaration: { kind: 'speech', catalogs: [{ kind: 'voices', settingFieldId: 'voiceId' }] } });
    expect(readLocalConversationVoiceSettings(voice)).toEqual({ ...cfg, tts: { ...cfg.tts, provider: 'local_neural',
      localNeural: { ...cfg.tts.localNeural, voiceId: 'af_heart', speed: 1.2 } } });
  });

  it('keeps device speech visible as an honest no-choice source', async () => {
    const voice = voiceSettingsParse({ providerId: 'local_conversation' });
    const hook = await renderHook(() => useBundledConversationProviderSettings(voice));
    expect(hook.getCurrent().sessionChoice).toMatchObject({ providerId: 'device',
      providerTitleKey: 'settingsVoice.local.deviceTts', declaration: null });
  });

  it('uses Google speech voiceName from the current speech declaration, with custom names', async () => {
    const providerId = 'happier.voice.google/google-cloud-tts';
    const owner = createDefaultVoiceProviderRegistry().get(providerId)?.providerSettings;
    if (!owner) throw new Error('Google settings declaration missing');
    const base = voiceSettingsParse({ providerId: 'local_conversation' });
    const cfg = readLocalConversationVoiceSettings(base);
    const withVoice = (voiceName: string, languageCode = 'en-US') => writeLocalConversationVoiceSettings(voiceSettingsParse({
      ...base, providers: { ...base.providers, [providerId]: { schemaVersion: owner.schemaVersion,
        config: { ...owner.defaultConfig, voiceName, languageCode } } },
    }), { ...cfg, tts: { ...cfg.tts, provider: providerId } });
    const hook = await renderHook(voice => useBundledConversationProviderSettings(voice), {
      initialProps: withVoice('en-US-Neural2-C'),
    });
    expect(hook.getCurrent().sessionChoice).toMatchObject({ providerId: 'happier.voice.google/google-cloud-tts',
      providerTitleKey: 'settingsVoice.local.googleCloudTts.provider.title',
      declaration: { kind: 'speech', catalogs: [{ kind: 'voices', settingFieldId: 'voiceName', allowCustom: true }] } });
    const target = hook.getCurrent().sessionChoice?.targetKey;
    await hook.rerender(withVoice('en-US-Neural2-D'));
    expect(hook.getCurrent().sessionChoice?.targetKey).toBe(target);
    await hook.rerender(withVoice('en-US-Neural2-D', 'fr-FR'));
    expect(hook.getCurrent().sessionChoice?.targetKey).not.toBe(target);
  });

  it('retains the selected conversation display identity for a true realtime provider', async () => {
    const entry = createDefaultVoiceProviderRegistry().get('happier.voice.openai/realtime-openai');
    const option = entry?.selectionOptions?.[0];
    if (!entry?.providerSettings || !option) throw new Error('OpenAI settings declaration missing');
    const voice = voiceSettingsParse({ providerId: 'happier.voice.openai/realtime-openai', providers: {
      'happier.voice.openai/realtime-openai': { schemaVersion: entry.providerSettings.schemaVersion,
        config: entry.providerSettings.defaultConfig },
    } });
    const hook = await renderHook(() => useBundledConversationProviderSettings(voice));
    expect(hook.getCurrent().sessionChoice).toMatchObject({ providerId: 'happier.voice.openai/realtime-openai',
      providerTitleKey: option.titleKey });
  });

  it('invalidates the local catalog on pack/execution changes, not on voice or speed changes', async () => {
    const base = voiceSettingsParse({ providerId: 'local_conversation' });
    const cfg = readLocalConversationVoiceSettings(base);
    const withLocal = (patch: Partial<typeof cfg.tts.localNeural>) => writeLocalConversationVoiceSettings(base, {
      ...cfg, tts: { ...cfg.tts, provider: 'local_neural', localNeural: { ...cfg.tts.localNeural, ...patch } },
    });
    const hook = await renderHook(voice => useBundledConversationProviderSettings(voice), { initialProps: withLocal({}) });
    const original = hook.getCurrent().sessionChoice?.targetKey;
    await hook.rerender(withLocal({ voiceId: 'af_heart', speed: 1.2 }));
    expect(hook.getCurrent().sessionChoice?.targetKey).toBe(original);
    await hook.rerender(withLocal({ assetId: 'different-installed-pack' }));
    expect(hook.getCurrent().sessionChoice?.targetKey).not.toBe(original);
    await hook.rerender(withLocal({ execution: 'device' }));
    expect(hook.getCurrent().sessionChoice?.targetKey).not.toBe(original);
  });
});
