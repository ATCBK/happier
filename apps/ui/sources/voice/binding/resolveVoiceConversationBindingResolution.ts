import {
    ensureVoiceConversationSessionForSessionRoot,
    ensureVoiceConversationSessionForVoiceHome,
} from '@/voice/persistence/voiceConversationSession';
import { applyRecoveredGlobalVoiceMachineDecision } from '@/voice/agent/applyRecoveredGlobalVoiceMachineDecision';
import { recoverUnavailableGlobalVoiceAutoMachine } from '@/voice/agent/recoverUnavailableGlobalVoiceAutoMachine';
import { shouldRecoverUnavailableGlobalVoiceAutoMachine } from '@/voice/agent/shouldRecoverUnavailableGlobalVoiceAutoMachine';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { getVoiceAdapterRegistry } from '@/voice/session/voiceAdapterRegistry';
import type { VoiceAdapterTranscriptMode } from '@/voice/session/types';

import type { VoiceConversationBindingResolution } from './voiceConversationBindingTypes';
import { readLocalConversationVoiceSettings, voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { storage } from '@/sync/domains/state/storage';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';
import { isVoiceConversationSystemSessionMetadata, shouldRetireLegacyVoiceConversationSession } from '@/voice/persistence/voiceConversationSystemSessionLookup';
import { readVoiceConversationScopeMetadata } from '@/voice/persistence/voiceConversationScopeMetadata';
import { readPreferredVoiceConversationBindingMetadata } from './voiceConversationBindingMetadata';
import { sync } from '@/sync/sync';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

/**
 * Read the provider-owned transcript-mode decision for a voice adapter from the
 * registry. Generic binding code does not branch on provider ids: each adapter
 * exposes `resolveBindingTranscriptMode` (a capability) that returns the mode or
 * `null` when it has no hidden voice conversation session for these settings.
 */
function resolveBindingTranscriptMode(
    providerId: string,
    settings: unknown,
): VoiceAdapterTranscriptMode | null {
    const adapter = getVoiceAdapterRegistry().get(providerId);
    return adapter?.resolveBindingTranscriptMode?.(settings) ?? null;
}

function shouldForceVoiceHomeForLocalConversation(settings: any): boolean {
    const config = readLocalConversationVoiceSettings(voiceSettingsParse(settings?.voice));
    return config?.agent?.stayInVoiceHome === true;
}

async function ensureVoiceHomeConversationSessionIdWithRecovery(params: Readonly<{
    transcriptMode: VoiceAdapterTranscriptMode;
    controlSessionId: string;
    settings: any;
    signal?: AbortSignal;
}>): Promise<string> {
    try {
        return await ensureVoiceConversationSessionForVoiceHome(null, params.signal);
    } catch (error) {
        const isGlobalNativeSessionVoiceAgent =
            params.controlSessionId === VOICE_AGENT_GLOBAL_SESSION_ID
            && params.transcriptMode === 'native_session';
        if (!isGlobalNativeSessionVoiceAgent) throw error;
        if (!shouldRecoverUnavailableGlobalVoiceAutoMachine(error)) throw error;
        const recoveryDecision = await recoverUnavailableGlobalVoiceAutoMachine();
        if (recoveryDecision.kind !== 'retry' && recoveryDecision.kind !== 'switch') throw error;
        applyRecoveredGlobalVoiceMachineDecision(recoveryDecision);
        return await ensureVoiceConversationSessionForVoiceHome(null, params.signal);
    }
}

export async function ensureVoiceConversationBindingResolution(params: Readonly<{
    providerId: string;
    controlSessionId: string;
    requestedTargetSessionId?: string | null;
    requestedTargetServerId?: string | null;
    settings: any;
    signal?: AbortSignal;
}>): Promise<VoiceConversationBindingResolution | null> {
    const providerId = normalizeNonEmptyString(params.providerId);
    if (!providerId) return null;
    const controlSessionId = normalizeNonEmptyString(params.controlSessionId);
    if (!controlSessionId) return null;
    const targetSessionId = normalizeNonEmptyString(params.requestedTargetSessionId);
    const targetServerId = normalizeNonEmptyString(params.requestedTargetServerId)
        ?? normalizeNonEmptyString(getActiveServerSnapshot().serverId);
    const targetSessionAddress = normalizeSessionAddress(targetServerId, targetSessionId);

    const providerOwnedResolution = await getVoiceAdapterRegistry().get(providerId)?.resolveConversationBinding?.({
        controlSessionId,
        requestedTargetSessionAddress: targetSessionAddress,
        settings: params.settings,
        signal: params.signal,
    });
    if (providerOwnedResolution) {
        const conversationSessionAddress = normalizeSessionAddress(
            providerOwnedResolution.conversationSessionAddress.serverId,
            providerOwnedResolution.conversationSessionAddress.sessionId,
        );
        if (!conversationSessionAddress) return null;
        return {
            controlSessionId,
            conversationSessionId: conversationSessionAddress.sessionId,
            conversationSessionAddress,
            transcriptMode: providerOwnedResolution.transcriptMode,
            targetSessionAddress: providerOwnedResolution.targetSessionAddress,
        };
    }

    const transcriptMode = resolveBindingTranscriptMode(providerId, params.settings);
    if (!transcriptMode) return null;

    let requestedMetadata = targetSessionAddress
        ? readVoiceSessionOwnerMetadataFromState(storage.getState(), targetSessionAddress) : null;
    if (targetSessionAddress && !requestedMetadata
        && areServerProfileIdentifiersEquivalent(targetSessionAddress.serverId, getActiveServerSnapshot().serverId)) {
        await sync.ensureSessionVisibleForMessageRoute(targetSessionAddress.sessionId, { serverId: targetSessionAddress.serverId });
        requestedMetadata = readVoiceSessionOwnerMetadataFromState(storage.getState(), targetSessionAddress);
    }
    if (targetSessionAddress && isVoiceConversationSystemSessionMetadata(requestedMetadata)
        && !shouldRetireLegacyVoiceConversationSession({ metadata: requestedMetadata })) {
        const conversationSessionId = await ensureVoiceConversationSessionForSessionRoot({ sessionRootAddress: targetSessionAddress, signal: params.signal });
        const existing = readPreferredVoiceConversationBindingMetadata({ conversationSessionId,
            preferredMetadata: requestedMetadata, sourceServerId: targetSessionAddress.serverId });
        const scope = readVoiceConversationScopeMetadata(requestedMetadata);
        return { controlSessionId, conversationSessionId,
            conversationSessionAddress: { serverId: targetSessionAddress.serverId, sessionId: conversationSessionId }, transcriptMode,
            targetSessionAddress: existing ? existing.targetSessionAddress
                : (scope?.kind === 'session_root' ? normalizeSessionAddress(targetSessionAddress.serverId, scope.sessionRootId) : null) };
    }

    // The hidden conversation Session belongs to the same Home as its root Session: for the
    // global voice agent that is the resolved target address, and for a Session-attached
    // control session it is that Session in the Home the request was scoped to.
    const rootSessionAddress =
        controlSessionId === VOICE_AGENT_GLOBAL_SESSION_ID
            ? targetSessionAddress
            : normalizeSessionAddress(targetServerId, controlSessionId);

    const conversationSessionId =
        rootSessionAddress && !shouldForceVoiceHomeForLocalConversation(params.settings)
            ? await ensureVoiceConversationSessionForSessionRoot({ sessionRootAddress: rootSessionAddress, signal: params.signal })
            : await ensureVoiceHomeConversationSessionIdWithRecovery({
                  transcriptMode,
                  controlSessionId,
                  settings: params.settings,
                  signal: params.signal,
              });
    const conversationSessionAddress = normalizeSessionAddress(
        rootSessionAddress?.serverId ?? targetServerId,
        conversationSessionId,
    );
    if (!conversationSessionAddress) return null;

    return {
        controlSessionId,
        conversationSessionId,
        conversationSessionAddress,
        transcriptMode,
        targetSessionAddress,
    };
}
