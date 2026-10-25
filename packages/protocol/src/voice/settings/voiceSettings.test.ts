import { describe, expect, it } from 'vitest';
import { createVoiceSettingsOwner } from './voiceSettings.js';
import { createExternalVoiceProviderSettingsDescriptor, projectExternalVoiceProviderSettings } from './externalProviderSettings.js';
import { createExternalVoiceProviderSettingsOwner } from './providerSettings.js';
import { VoiceProviderSettingsSchema } from '../../plugins/contributions/voiceProviders.js';
import { parsePredecessorVoiceCredentialBindings } from './voiceCredentialBindingCompatibility.js';
import { VoiceCredentialBindingV1Schema, classifyLegacyVoiceCredentialCandidateV1 } from '../realtime/providerSettings.js';
import { selectVoiceProviderOption } from './providerSelection.js';
import type { VoiceSettingsRegistryEntry } from './providerRegistry.js';
import { VoiceSpeechDiagnosticsSettingsV1Schema } from '../diagnostics.js';
import { VoiceLocalConversationSchema } from './localConversation.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { BoundedLegacyJsonValueSchema } from '../../account/settings/catalog/legacyJson.js';
import { VoiceProviderSettingsEnvelopeV1Schema } from '../realtime/providerSettings.js';

describe('shared Voice settings owner', () => {
  const owner = createVoiceSettingsOwner({ bundledContributions: [] });

  it('defaults both neural speech roles to June Zipformer while retaining explicit pack choices', () => {
    const june = 'sherpa-onnx-streaming-zipformer-en-2023-06-26';
    const fresh = owner.voiceSettingsParse({});
    expect(owner.readLocalConversationVoiceSettings(fresh).stt.localNeural.assetId).toBe(june);
    expect(fresh.dictation.stt.localNeural.assetId).toBe(june);
    for (const assetId of ['sherpa-onnx-streaming-zipformer-en-20M-2023-02-17',
      'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8', null]) {
      const stored = owner.voiceSettingsParse({
        providers: { local_conversation: { schemaVersion: 1, config: {
          stt: { provider: 'local_neural', localNeural: { assetId } },
        } } },
        dictation: { sttBinding: 'same_as_local', stt: {
          provider: 'local_neural', localNeural: { assetId },
        } },
      });
      expect(owner.readLocalConversationVoiceSettings(stored).stt.localNeural.assetId).toBe(assetId);
      expect(stored.dictation.stt.localNeural.assetId).toBe(assetId);
      expect(stored.dictation.sttBinding).toBe('same_as_local');
    }
  });

  it('validates declaration-selected config patches strictly after reading stored preferences', () => {
    const descriptor = createExternalVoiceProviderSettingsDescriptor(VoiceProviderSettingsSchema.parse({
      schemaVersion: 1, fields: [{ id: 'voice', title: 'Voice', schema: { type: 'string', maxLength: 32 }, default: 'default', presentation: { control: 'text' } }],
    }));
    const providerId = 'example.voice/provider';
    const entry = { providerId, kind: 'voice.conversation-provider.v1', roles: ['realtime_conversation'],
      providerSettings: descriptor,
      projectSettings: (envelope: Readonly<{ schemaVersion: number; config: unknown }> | null) => projectExternalVoiceProviderSettings(envelope, descriptor),
      selectionOptions: [
        { id: 'valid', modeId: 'default', order: 1, titleKey: 'fixture', subtitleKey: 'fixture', configPatch: { voice: 'selected' } },
        { id: 'invalid', modeId: 'default', order: 2, titleKey: 'fixture', subtitleKey: 'fixture', configPatch: { retired: true } },
      ],
    } satisfies VoiceSettingsRegistryEntry;
    const registry = { get: (id: string) => id === providerId ? entry : null, list: () => [entry] };
    const settings = owner.voiceSettingsParse({ providers: { [providerId]: { schemaVersion: 1, config: { voice: 'stored', retired: true } } } });
    expect(selectVoiceProviderOption(settings, registry, providerId, 'valid')?.providers[providerId]?.config).toEqual({ voice: 'selected' });
    expect(selectVoiceProviderOption(settings, registry, providerId, 'invalid')).toBeNull();
  });

  it('projects retired fields from stored external provider settings without admitting them in edits', () => {
    const descriptor = createExternalVoiceProviderSettingsDescriptor(VoiceProviderSettingsSchema.parse({
      schemaVersion: 2,
      fields: [{ id: 'profile', title: 'Profile', schema: {
        type: 'object', properties: { voice: { type: 'string' } }, required: ['voice'], additionalProperties: false,
      }, default: { voice: 'default' }, presentation: { control: 'json' } }],
    }));
    const providerId = 'example.voice/provider';
    const providerOwner = createExternalVoiceProviderSettingsOwner(providerId, descriptor);
    const externalOwner = createVoiceSettingsOwner({ bundledContributions: [],
      resolveExternalProviderSettingsOwner: id => id === providerId ? providerOwner : null });
    const rawConfig = { profile: { voice: 'retained', retired: true }, retired: { active: true } };
    const accessorConfig = Object.defineProperty({}, 'profile', {
      enumerable: true, get: () => ({ voice: 'retained' }),
    });
    expect(descriptor.parseConfig(accessorConfig)).toBeNull();
    const settings = externalOwner.voiceSettingsParse({ providers: { [providerId]: { schemaVersion: 2, config: rawConfig, retired: true } } });
    expect(settings.providers[providerId]?.config).toEqual({ profile: { voice: 'retained' } });
    expect(externalOwner.readVoiceProviderSettingsConfig(settings, providerId)).toEqual({ profile: { voice: 'retained' } });
    expect(() => externalOwner.writeVoiceProviderSettingsConfig(settings, providerId, rawConfig)).toThrow();
    expect(externalOwner.readVoiceProviderSettingsConfig(externalOwner.voiceSettingsParse({ providers: {
      [providerId]: { schemaVersion: 2, config: { profile: { voice: 42, retired: true } } },
    } }), providerId)).toBeNull();
  });

  it('retains stored local conversation selections while dropping nested retired fields', () => {
    const settings = owner.voiceSettingsParse({ providers: { local_conversation: { schemaVersion: 1, config: {
      agent: { agentIdentity: { pluginId: 'example.agent', localId: 'agent', retired: true },
        providerChat: { status: 'configured', retired: true,
          chat: { agentTargetKey: 'agent:codex', providerConnectionId: null, modelId: 'chat', retired: true },
          commit: { agentTargetKey: 'agent:codex', providerConnectionId: null, modelId: 'commit', retired: true } } },
    } } } });
    const local = owner.readLocalConversationVoiceSettings(settings);
    expect(local.agent.agentIdentity).toEqual({ pluginId: 'example.agent', localId: 'agent' });
    expect(local.agent.providerChat).toEqual({ status: 'configured',
      chat: { agentTargetKey: 'agent:codex', providerConnectionId: null, modelId: 'chat' },
      commit: { agentTargetKey: 'agent:codex', providerConnectionId: null, modelId: 'commit' } });
  });

  it('retains known stored credential bindings without assigning retired fields credential meaning', () => {
    const binding = { contribution: { pluginId: 'example.voice', localId: 'provider', retired: true },
      credentialSlotId: 'api_key', credentialSource: { kind: 'savedSecret', retired: true },
      credentialBindings: { account: { api_key: 'secret-id' }, retired: true }, retired: true };
    expect(owner.voiceSettingsParse({ credentialBindings: [binding] }).credentialBindings).toEqual([{
      contribution: { pluginId: 'example.voice', localId: 'provider' }, credentialSlotId: 'api_key',
      credentialSource: { kind: 'savedSecret' }, credentialBindings: { account: { api_key: 'secret-id' } },
    }]);
    expect(VoiceCredentialBindingV1Schema.safeParse(binding).success).toBe(false);
    expect(owner.voiceSettingsParse({ credentialBindings: [{ ...binding, credentialSource: { kind: 'retired' } }] }).credentialBindings).toEqual([]);
  });

  it('reads predecessor credential carriers with retired fields', () => {
    expect(parsePredecessorVoiceCredentialBindings({ credentialBindings: [{ providerId: 'openai_compat',
      credentialBindings: { account: { chat_api_key: 'secret-id' }, retired: true }, retired: true }] })).toEqual([{
      providerId: 'openai_compat', credentialBindings: { account: { chat_api_key: 'secret-id' } },
    }]);
  });

  it('classifies retained legacy credential material through the same tolerant binding projection', () => {
    const secret = { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'encrypted' } };
    expect(classifyLegacyVoiceCredentialCandidateV1({
      candidate: { providerId: 'realtime_elevenlabs', slotId: 'api_key', path: ['realtime_elevenlabs', 'byo', 'apiKey'] },
      rawAdapters: { realtime_elevenlabs: { byo: { apiKey: secret } } },
      personalSources: [{ id: 'existing-personal', encryptedValue: { ...secret, retired: true } }],
      credentialBindings: [{ providerId: 'realtime_elevenlabs', credentialBindings: {
        account: { api_key: 'existing-personal' }, retired: true,
      }, retired: true }],
    })).toMatchObject({ kind: 'existing-personal', secretId: 'existing-personal',
      binding: { providerId: 'realtime_elevenlabs', credentialBindings: { account: { api_key: 'existing-personal' } } } });
  });

  it('preserves stored diagnostics consent without enabling invalid capture settings', () => {
    const diagnostics = { v: 1, enabled: true, consentVersion: 1, captureSttInput: true, retired: true };
    const settings = owner.voiceSettingsParse({ diagnostics });
    expect(owner.readVoiceDiagnosticsSettings(settings)).toMatchObject({ enabled: true, consentVersion: 1, captureSttInput: true });
    const written = owner.writeVoiceDiagnosticsSettings(settings, owner.readVoiceDiagnosticsSettings(settings));
    const stored = owner.voiceSettingsParse(JSON.parse(JSON.stringify(written)));
    expect(VoiceSpeechDiagnosticsSettingsV1Schema.parse(stored.diagnostics)).toEqual(owner.readVoiceDiagnosticsSettings(settings));
    expect(stored.providers).toEqual(settings.providers);
    expect(Reflect.get(settings.diagnostics, 'retired')).toBeUndefined();
    expect(owner.voiceSettingsParse({ diagnostics: { ...diagnostics, consentVersion: 2 } }).diagnostics.enabled).toBe(false);
    const diagnosticsWithRetiredFields = { ...settings.diagnostics, retired: true };
    expect(() => owner.writeVoiceDiagnosticsSettings(settings, diagnosticsWithRetiredFields)).toThrow();
  });

  it('preserves forward provider envelopes and unknown roots while recovering malformed known preferences', () => {
    const future = { schemaVersion: 2, config: { futureMode: true } };
    const settings = owner.voiceSettingsParse({
      privacy: { shareFilePaths: 'invalid' },
      providers: { 'example.voice.future/conversation': future },
      futurePreference: { enabled: true },
    });
    expect(settings.privacy.shareFilePaths).toBe(false);
    expect(settings.providers['example.voice.future/conversation']).toEqual(future);
    expect(Reflect.get(settings, 'futurePreference')).toEqual({ enabled: true });
  });

  it('preserves catalog-admitted stored Voice data without a second size or cardinality policy', () => {
    const future = { entries: Array.from({ length: 4097 }, (_, index) => `retained preference ${index}`) };
    const raw = createStoredReadSchema(BoundedLegacyJsonValueSchema).parse({
      futurePreference: future,
      providers: { 'example.voice.future/conversation': { schemaVersion: 2, config: future } },
    });
    const settings = owner.voiceSettingsParse(raw);
    expect(Reflect.get(settings, 'futurePreference')).toEqual(future);
    expect(settings.providers['example.voice.future/conversation']).toEqual({ schemaVersion: 2, config: future });
    expect(owner.voiceSettingsParse(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
  });

  it('delegates opaque Voice JSON admission to the strict JSON owner without invoking accessors', () => {
    let reads = 0;
    const unsafe = Object.defineProperty({}, 'value', { enumerable: true, get: () => { reads += 1; return 'unsafe'; } });
    const settings = owner.voiceSettingsParse({ futurePreference: unsafe });
    expect(Reflect.has(settings, 'futurePreference')).toBe(false);
    expect(VoiceProviderSettingsEnvelopeV1Schema.safeParse({ schemaVersion: 2, config: unsafe }).success).toBe(false);
    expect(reads).toBe(0);
  });

  it('uses the same local conversation schema and writer without changing other Voice owners', () => {
    const settings = owner.voiceSettingsParse({ assistantLanguage: 'fr', welcome: { enabled: false } });
    const conversation = owner.readLocalConversationVoiceSettings(settings);
    const written = owner.writeLocalConversationVoiceSettings(settings, {
      ...conversation, handsFree: { ...conversation.handsFree, enabled: true },
      agent: { ...conversation.agent, idleTtlSeconds: 999999 },
    });
    const stored = owner.voiceSettingsParse(JSON.parse(JSON.stringify(written)));
    const envelope = stored.providers.local_conversation;
    if (!envelope) throw new Error('Missing persisted local conversation envelope');
    const consumer = VoiceLocalConversationSchema.parse(envelope.config);
    expect(consumer).toMatchObject({ handsFree: { enabled: true }, agent: { idleTtlSeconds: 999999 } });
    const restored = owner.readLocalConversationVoiceSettings(stored);
    expect(restored.agent.idleTtlSeconds).toBe(999999);
    expect(restored).toEqual(owner.readLocalConversationVoiceSettings(written));
    expect(written.welcome).toEqual(settings.welcome);
    expect(written.assistantLanguage).toBe('fr');
    expect(owner.readLocalDirectVoiceSettings(written)).toEqual(owner.readLocalDirectVoiceSettings(settings));
  });
});
