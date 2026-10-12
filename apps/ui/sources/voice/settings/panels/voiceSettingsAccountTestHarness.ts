import { vi } from 'vitest';
import { settingsParse, type Settings } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import type { PluginApi } from '@happier-dev/plugin-sdk';
import type { VoiceAccountOperationService } from '@happier-dev/plugin-sdk/voice';
import { BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES } from '@/voice/registry/generatedBundledVoiceRuntimeEntries';
import { bindVoiceProviderSettingsActions, bindVoiceProviderSettingsOperations } from '@/voice/registry/externalVoiceProviderActivation';
import { commitExternalVoiceProviderRegistration, removeExternalVoiceProviderRegistration } from '@/voice/registry/externalVoiceProviderRegistrations';
import { normalizeVoiceSettingsLocalDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import type { ConnectedPurposeCatalogV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';

/** Real Account Settings owner; only the Home HTTP transport is synthetic. */
export async function createVoiceSettingsAccountTestHarness(settings: Settings) {
    const account = await createSecretSettingsTestHarness({ settings, voiceEnabled: true, connectedPurposes: { v: 1, bindings: [] } });
    const { replaceSettings } = account;
    await account.purposes!.hydrate(account.scope);
    return {
        ...account,
        purposes: account.purposes!,
        writes: account.settingsWrites,
        get settings() { return storage.getState().settings; },
        get persistedSettings() { return account.persistedSettings; },
        async replaceConnectedPurposes(next: ConnectedPurposeCatalogV1) {
            account.purposes!.replace(next);
            await account.purposes!.hydrate(account.scope);
        },
        replaceSettings,
        replaceVoice(next: VoiceSettings) {
            const current = storage.getState().settings;
            replaceSettings(settingsParse({ ...current, ...normalizeVoiceSettingsLocalDelta({ voice: next }, current) }));
        },
    };
}

/** Activates the shipped leaf and replaces only the provider's account HTTP port. */
export function createElevenLabsSettingsRuntimeTestHarness() {
    const entry = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES.find((candidate) => candidate.declaration.id === 'realtime-elevenlabs');
    if (!entry) throw new Error('ElevenLabs runtime entry missing');
    const runtimes: Parameters<PluginApi['voiceProviders']['register']>[1][] = [];
    entry.activate({ voiceProviders: { register(_id, runtime) { runtimes.push(runtime); } } });
    const runtime = runtimes[0];
    if (runtime?.kind !== 'conversation' || !runtime.settingsOperations || !runtime.settingsActions) throw new Error('ElevenLabs settings runtime missing');
    let nextToolId = 0;
    let createdAgentConfig: Readonly<Record<string, unknown>> | null = null;
    const response = (body: unknown, status = 200): Awaited<ReturnType<VoiceAccountOperationService['request']>> => Object.freeze({
        status, finalUrl: 'https://api.elevenlabs.io/test', headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify(body)),
    });
    const request = vi.fn(async (input: Parameters<VoiceAccountOperationService['request']>[0]): ReturnType<VoiceAccountOperationService['request']> => {
        if (input.operationId === 'agents') return response({ agents: [], has_more: false, next_cursor: null });
        if (input.operationId === 'voices') return response({ voices: [{ voice_id: 'hpp4J3VqNfWAUOO0d1Us', name: 'Happier voice', category: 'premade' }] });
        if (input.operationId === 'tools') return response({ tools: [], has_more: false, next_cursor: null });
        if (input.operationId === 'create-tool') return response({ id: `tool_${++nextToolId}` });
        if (input.operationId === 'create-agent') {
            const body = input.parameters?.body;
            if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected authored ElevenLabs Agent body');
            // The HTTP fixture retains the provider-authored JSON object, not a second config owner.
            createdAgentConfig = body as Readonly<Record<string, unknown>>;
            return response({ agent_id: 'agent_created' });
        }
        if (input.operationId === 'agent') {
            if (!createdAgentConfig) throw new Error('Expected an Agent created through the HTTP fixture');
            return response({ ...createdAgentConfig, agent_id: input.parameters?.agentId });
        }
        return response({});
    });
    const credentials = () => Object.freeze({ phase: 'settings' as const, mediated: Object.freeze({ request }), raw: null });
    const settingsOperations = bindVoiceProviderSettingsOperations({ operations: runtime.settingsOperations, createCredentials: credentials, isCurrent: () => true });
    const settingsActions = bindVoiceProviderSettingsActions({
        actions: runtime.settingsActions, declaredActions: entry.declaration.settings?.actions ?? [],
        createCredentials: credentials, createInteractions: () => Object.freeze({
            askQuestions: async () => Object.freeze({ requestId: 'test-questions', kind: 'questions' as const, status: 'answered' as const,
                answers: { 'existing-agent-action': { kind: 'singleChoice' as const, answer: { kind: 'choice' as const, choiceId: 'create-new' } } },
            }),
        }),
        getRealtimeClientToolDefinitions: () => [{ name: 'listMachines', description: 'List machines',
            parameters: { type: 'object', additionalProperties: false }, execute: async () => ({ ok: true }) }],
        isCurrent: () => true,
    });
    const token = Object.freeze({});
    const registration = Object.freeze({ token, pluginId: entry.pluginId, localId: entry.declaration.id,
        providerId: `${entry.pluginId}/${entry.declaration.id}`, occurrenceId: 'voice-settings-test-occurrence',
        descriptor: null, adapter: null, settingsOperations, settingsActions });
    return {
        request, response, registration, entry,
        register() { commitExternalVoiceProviderRegistration(registration); },
        async dispose() { removeExternalVoiceProviderRegistration(token); await runtime.dispose?.(); },
    };
}
