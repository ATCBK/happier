import type { StoredCredentials } from '@/persistence';
import { updateSessionMetadataWithRetry, verifySessionMetadataMutationCurrentness,
    type SessionMetadataMutationCurrentness } from '@/session/metadata/updateSessionMetadataWithRetry';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import type { TerminalMode } from '@/terminal/runtime/terminalConfig';
import { configuration } from '@/configuration';
import { isPidPresent } from '@happier-dev/cli-common/process';
import { readTerminalHostAttachmentState } from '@/terminal/attachment/terminalAttachmentInfo';
import { logger } from '@/ui/logger';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { readSessionMarkerForPid, type DaemonSessionMarker } from '../sessionRegistry';
import type { TrackedSession } from '../types';

import { clearTerminalControlServiceabilityProjection } from '../startup/terminalControlServiceabilityProjection';

export type ExactTerminalControlServiceabilityRetirement = 'retired' | 'superseded';
export type RetainedPlainRunnerRetirement = ExactTerminalControlServiceabilityRetirement | 'deferred';
export type TerminalControlServiceabilityRetirementTarget = Readonly<{ attachmentId: string; terminalMode: TerminalMode; expectedRunner?: never }>
    | Readonly<{ attachmentId?: never; terminalMode: 'plain'; expectedRunner: Readonly<{ pid: number; startTimeMs?: number }> }>;

/** The existing marker is the recovery obligation; a live or unrecorded runner cannot defer publication. */
export async function readRetainedPlainRunnerExitMarker(tracked: TrackedSession): Promise<DaemonSessionMarker | null> {
    const pid = tracked.sessionRunnerPid ?? tracked.pid;
    const startTimeMs = tracked.runnerProcessIdentity?.processStartTimeMs ?? tracked.processStartTimeMs;
    if (tracked.startedBy !== 'daemon' || !tracked.happySessionId || startTimeMs === undefined
        || isPidPresent(pid) || (pid !== tracked.pid && isPidPresent(tracked.pid))) return null;
    const marker = await readSessionMarkerForPid(pid);
    if (!marker || marker.startedBy !== 'daemon' || marker.happySessionId !== tracked.happySessionId
        || marker.processStartTimeMs !== startTimeMs) return null;
    const attachment = await readTerminalHostAttachmentState({ happyHomeDir: configuration.happyHomeDir, sessionId: marker.happySessionId });
    return attachment.status === 'absent' ? marker : null;
}

export async function retireStoppedPlainRunnerControlServiceability(params: Readonly<{
    sessionId: string;
    trackedSession: TrackedSession;
    publishRetirement: () => Promise<ExactTerminalControlServiceabilityRetirement>;
}>): Promise<RetainedPlainRunnerRetirement> {
    try {
        return await params.publishRetirement();
    } catch (error) {
        if (params.trackedSession.happySessionId !== params.sessionId
            || !await readRetainedPlainRunnerExitMarker(params.trackedSession)) throw error;
        logger.warn('[DAEMON STOP] Home retirement deferred to retained Session marker', {
            sessionId: params.sessionId, error: serializeAxiosErrorForLog(error),
        });
        return 'deferred';
    }
}

export async function retireExactTerminalControlServiceability(params: Readonly<{
    credentials: StoredCredentials;
    sessionId: string;
    currentness?: SessionMetadataMutationCurrentness;
}> & TerminalControlServiceabilityRetirementTarget): Promise<ExactTerminalControlServiceabilityRetirement> {
    const matchesExpectedRunner = (metadata: Readonly<{ hostPid?: number; hostProcessStartTimeMs?: number }>) =>
        !params.expectedRunner || (metadata.hostPid === params.expectedRunner.pid
            && (params.expectedRunner.startTimeMs === undefined || metadata.hostProcessStartTimeMs === params.expectedRunner.startTimeMs));
    await verifySessionMetadataMutationCurrentness(params.currentness);
    const rawSession = await fetchSessionByIdCompat({
        token: params.credentials.token,
        sessionId: params.sessionId,
    });
    if (!rawSession) {
        throw new Error('terminal_control_serviceability_retirement_session_not_found');
    }
    let retiredAttachmentId = params.attachmentId;
    let projectionAlreadyAbsent = false;
    const updated = await updateSessionMetadataWithRetry({
        token: params.credentials.token,
        credentials: params.credentials,
        sessionId: params.sessionId,
        rawSession,
        currentness: params.currentness,
        updater: async (metadata) => {
            retiredAttachmentId = params.attachmentId;
            projectionAlreadyAbsent = false;
            if (!matchesExpectedRunner(metadata)) return metadata;
            if (params.expectedRunner) {
                const attachment = await readTerminalHostAttachmentState({
                    happyHomeDir: configuration.happyHomeDir, sessionId: params.sessionId,
                });
                if (attachment.status !== 'absent' || isPidPresent(params.expectedRunner.pid)) {
                    throw new Error('terminal_control_serviceability_retirement_runner_or_host_unresolved');
                }
                // Runner-bound retirement also clears that departed runner's
                // historical host projection. A current descriptor or a newer
                // metadata runner cannot lend authority to this mutation.
                const terminal = metadata.terminal;
                // A mode-only terminal descriptor already has no control projection.
                // Retain the incumbent legacy path when terminal metadata is absent.
                if (terminal && typeof terminal === 'object' && !Array.isArray(terminal)
                    && !('controlServiceabilityV1' in terminal)) {
                    projectionAlreadyAbsent = true;
                    return metadata;
                }
                if (terminal && typeof terminal === 'object' && !Array.isArray(terminal)) {
                    const serviceability = (terminal as Record<string, unknown>).controlServiceabilityV1;
                    if (serviceability && typeof serviceability === 'object' && !Array.isArray(serviceability)) {
                        const attachmentId = (serviceability as Record<string, unknown>).attachmentId;
                        if (typeof attachmentId === 'string' && attachmentId.trim()) retiredAttachmentId = attachmentId;
                    }
                }
            }
            return clearTerminalControlServiceabilityProjection({
                metadata,
                retiredAttachmentId,
                retiredAt: Date.now(),
                terminalMode: params.terminalMode,
            });
        },
    });
    if (!matchesExpectedRunner(updated.metadata)) return 'superseded';
    if (projectionAlreadyAbsent) return 'retired';
    const terminal = updated.metadata.terminal;
    if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)) return 'superseded';
    const serviceability = (terminal as Record<string, unknown>).controlServiceabilityV1;
    if (!serviceability || typeof serviceability !== 'object' || Array.isArray(serviceability)) return 'superseded';
    const projection = serviceability as Record<string, unknown>;
    return projection.attachmentId === retiredAttachmentId && projection.retired === true
        ? 'retired'
        : 'superseded';
}
