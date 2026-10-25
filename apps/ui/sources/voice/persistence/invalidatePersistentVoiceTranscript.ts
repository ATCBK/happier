import { storage } from '@/sync/domains/state/storage';
import { readLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { areAccountSettingsScopesEqual, type AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { advancePersistentVoiceTranscriptEpoch } from './voiceTranscriptMemory';

export async function invalidatePersistentVoiceTranscript(
    expectedSettingsScope: AccountSettingsScope | null,
): Promise<number | null> {
    const state = storage.getState();
    if (!expectedSettingsScope || !areAccountSettingsScopesEqual(expectedSettingsScope, state.settingsScope)) return null;
    if (readLocalConversationVoiceSettings(state.settings.voice).agent.transcript.persistenceMode !== 'persistent') return null;
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime || !areAccountSettingsScopesEqual(lifetime.scope, expectedSettingsScope)) return null;
    return await advancePersistentVoiceTranscriptEpoch(lifetime);
}
