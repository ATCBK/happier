import { SessionModelSelectionV1Schema, type SessionModelSelectionV1 } from '@happier-dev/protocol/providers/model-selection';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { resolveSessionModelSelectionDisposition } from '@/sync/domains/models/resolveSessionModelSelectionDisposition';
import { storage } from '@/sync/domains/state/storage';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { getSessionRunnerRuntimeStatusSnapshot } from '@/sync/ops/sessionRunnerRestart';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';

/** Adapt the current Session model owner to a carrier launch; intent and history cannot prove an active choice. */
export async function resolveVoiceSessionModelSelection(params: Readonly<{
    sessionAddress: SessionAddress;
    agentId: string;
    agentTargetKey: string;
    signal?: AbortSignal;
}>): Promise<SessionModelSelectionV1 | null> {
    const metadata = readVoiceSessionOwnerMetadataFromState(storage.getState(), params.sessionAddress);
    const machineId = normalizeNonEmptyString(readMachineTargetForSession(params.sessionAddress.sessionId)?.machineId)
        ?? normalizeNonEmptyString(metadata?.machineId);
    if (!machineId) return null;
    const snapshot = await getSessionRunnerRuntimeStatusSnapshot({
        sessionId: params.sessionAddress.sessionId, machineId, serverId: params.sessionAddress.serverId,
        signal: params.signal,
    });
    if (!snapshot || snapshot.state.machineId !== machineId) return null;
    // The Session owner proves the source against the exact current runner.
    // Voice's chat/commit contract cannot carry Team custody (startRequest.ts),
    // so preserve that refusal instead of launching the backing native tuple.
    const { activeSelection, activeRouteSelection } = resolveSessionModelSelectionDisposition({
        agentId: params.agentId, agentTargetKey: params.agentTargetKey, sessionActive: true,
        metadata: readVoiceSessionOwnerMetadataFromState(storage.getState(), params.sessionAddress),
        currentRunnerProcessIdentity: snapshot.runnerProcessIdentity,
    });
    if (activeRouteSelection && 'source' in activeRouteSelection && activeRouteSelection.source === 'team_resource') {
        throw Object.assign(new Error('Voice does not support Team credential models.'), {
            code: 'VOICE_AGENT_TEAM_MODEL_UNSUPPORTED',
        });
    }
    return activeSelection ? SessionModelSelectionV1Schema.parse({
        v: 1, ref: activeSelection, updatedAt: snapshot.state.observedAtMs,
    }) : null;
}
