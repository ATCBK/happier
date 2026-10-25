import { ConnectedServiceBindingsV1Schema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { SettingsDeclarationValueV1Schema } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { resolveConnectedServiceSessionSelection } from '@happier-dev/agents';

import type { SettingOperationContext, SettingOperationResult } from '@/components/settings/catalog/settingDeclarations';
import { buildConnectedServiceAccountGroupOptionsByServiceId, buildConnectedServiceProfileOptionsByServiceId } from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';
import { resolveQualifiedConnectedAccountServiceKey } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { getConnectedMetadataCatalog } from '@/sync/store/settings/connectedMetadataCatalogSnapshot';
import { normalizeVoiceSettingsLocalDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import { readVoiceProviderSettingsConfig, writeVoiceProviderSettingsConfig } from '@/sync/domains/settings/voiceSettings';
import { sync } from '@/sync/sync';
import type { VoiceProviderRegistry, VoiceProviderRegistryEntry } from '@/voice/registry/providerRegistry';
import { updateRealtimeProviderConfig } from './panels/realtime/descriptor';

function record(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The declared provider field, not the Account's purpose default, owns this selection. */
export async function invokeVoiceConnectedServicesSettingsOperation(entry: VoiceProviderRegistryEntry,
    registry: VoiceProviderRegistry, context: SettingOperationContext): Promise<SettingOperationResult> {
    const input = context.input;
    const descriptor = entry.providerSettings;
    const binding = descriptor?.connectedServicesBinding;
    const scope = context.accountScope;
    if (input?.kind !== 'voice_connected_services') return { status: 'unavailable', reason: 'operation_input_required' };
    if (!scope || !descriptor || !binding) return { status: 'unavailable', reason: 'credential_source_unavailable' };
    const groupsEnabled = await context.isFeatureEnabled?.('connectedServices.accountGroups') === true;
    const isCurrent = () => context.isCurrent() && !context.signal?.aborted
        && areAccountSettingsScopesEqual(storage.getState().settingsScope, scope)
        && registry.get(entry.providerId)?.providerSettings === descriptor;
    const admitted = () => {
        if (!isCurrent()) return false;
        const state = storage.getState();
        const envelope = state.settings.voice.providers[entry.providerId];
        if (envelope && envelope.schemaVersion !== descriptor.schemaVersion) return false;
        if (input.value === null) return true;
        const supported = new Map(binding.serviceIds.map(id => [resolveQualifiedConnectedAccountServiceKey(id), id]));
        const currentConfig = envelope ? readVoiceProviderSettingsConfig(state.settings.voice, entry.providerId) : descriptor.defaultConfig;
        const old = currentConfig && typeof currentConfig === 'object'
            ? ConnectedServiceBindingsV1Schema.safeParse(Reflect.get(currentConfig, binding.id)) : null;
        for (const [key, value] of Object.entries(input.value.bindingsByServiceId)) {
            // Keep a retained unrelated choice; admission cannot introduce a new undeclared service.
            if (!supported.has(key) && (!old?.success || !sameStrictJsonValue(old.data.bindingsByServiceId[key], value))) return false;
        }
        const profiles = state.profile.connectedServicesV2 ?? [];
        const profileOptions = buildConnectedServiceProfileOptionsByServiceId({
            accountProfileConnectedServicesV2: profiles, supportedConnectedServiceIds: binding.serviceIds,
            labelsByKey: getConnectedMetadataCatalog(scope).labelsByKey });
        const groupOptions = buildConnectedServiceAccountGroupOptionsByServiceId({
            accountGroupsFeatureEnabled: groupsEnabled, accountProfileConnectedServicesV2: profiles, supportedConnectedServiceIds: binding.serviceIds });
        return Object.entries(input.value.bindingsByServiceId).every(([key, requested]) => {
            const declaredId = supported.get(key);
            if (!declaredId || requested.source === 'native') return true;
            return resolveConnectedServiceSessionSelection({ serviceId: key, binding: requested,
                availability: { kind: 'known', profileOptions: profileOptions[key] ?? profileOptions[declaredId] ?? [],
                    groupOptions: groupOptions[key] ?? groupOptions[declaredId] ?? [], accountGroupsEnabled: groupsEnabled },
                defaultProfileByServiceId: {},
            }).status === 'valid_selection';
        });
    };
    if (!admitted()) return { status: 'unavailable', reason: 'credential_source_unavailable' };
    const result = await sync.mutateAccountSettingsOnce({ expectedSettingsScope: scope, expectedSettingsVersion: input.expectedSettingsVersion,
        mutate: raw => {
            if (!admitted()) throw new Error('voice_credential_source_stale');
            const settings = settingsParse(raw);
            const envelope = settings.voice.providers[entry.providerId];
            if (envelope && envelope.schemaVersion !== descriptor.schemaVersion) throw new Error('voice_credential_source_stale');
            const config = envelope ? readVoiceProviderSettingsConfig(settings.voice, entry.providerId) : descriptor.defaultConfig;
            if (!record(config)) throw new Error('voice_credential_source_invalid');
            const next = updateRealtimeProviderConfig({ parseConfig: value => {
                const parsed = descriptor.parseConfig(value);
                return record(parsed) ? parsed : null;
            } }, config, [binding.id], input.value);
            if (!next) throw new Error('voice_credential_source_invalid');
            const voice = writeVoiceProviderSettingsConfig(settings.voice, entry.providerId, next);
            return { settings: { ...raw, ...normalizeVoiceSettingsLocalDelta({ voice }, settings) }, value: undefined };
        },
    });
    const { value: _value, ...receipt } = result.status === 'applied' ? result : { ...result, value: undefined };
    return { status: 'completed', value: SettingsDeclarationValueV1Schema.parse(receipt) };
}
