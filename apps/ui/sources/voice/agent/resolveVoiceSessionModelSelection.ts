import { readActiveSessionModelSelectionFromMetadata } from '@happier-dev/agents';
import { SessionModelSelectionV1Schema, type SessionModelSelectionV1 } from '@happier-dev/protocol/providers/model-selection';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
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
    const selection = readActiveSessionModelSelectionFromMetadata(
        readVoiceSessionOwnerMetadataFromState(storage.getState(), params.sessionAddress),
        params.agentId, params.agentTargetKey, snapshot.runnerProcessIdentity,
    );
    return selection ? SessionModelSelectionV1Schema.parse({
        v: 1, ref: selection, updatedAt: snapshot.state.observedAtMs,
    }) : null;
}
