import type { Session } from '@/sync/domains/state/storageTypes';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import {
    compareSessionListSessionOrderingKeys,
    readSessionListUpdatedOrderingKey,
    type SessionListSessionOrderingKey,
} from '@/sync/domains/session/listing/sessionListOrderingRules';

export type TranscriptSendToSessionTargetCandidate = Readonly<{
    id: string;
    serverId?: string | null;
    access?: Session['access'];
    metadata?: unknown;
    metadataUnavailable?: boolean;
    meaningfulActivityAt?: number | null;
    updatedAt?: number | null;
    createdAt?: number | null;
}>;

function normalizeId(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function readTimestamp(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function buildDestinationOrderingKey(candidate: TranscriptSendToSessionTargetCandidate): SessionListSessionOrderingKey {
    return {
        updated: readSessionListUpdatedOrderingKey(candidate),
        createdAt: readTimestamp(candidate.createdAt),
        stableId: normalizeId(candidate.id),
    };
}

function isWritableSession(candidate: TranscriptSendToSessionTargetCandidate): boolean {
    return candidate.access?.capabilities.submitAgentInput === true;
}

function isReadableSession(candidate: TranscriptSendToSessionTargetCandidate): boolean {
    return candidate.access?.capabilities.readTranscript === true;
}

function resolveQualifiedSessionTargets(params: Readonly<{
    excludedSessionId: string;
    serverId: string | null | undefined;
    sessions: ReadonlyArray<TranscriptSendToSessionTargetCandidate>;
    accepts(candidate: TranscriptSendToSessionTargetCandidate): boolean;
}>): ReadonlyArray<TranscriptSendToSessionTargetCandidate> {
    const excludedSessionId = normalizeId(params.excludedSessionId);
    const serverId = normalizeId(params.serverId);
    if (!serverId) return [];

    return params.sessions
        .filter((session) => {
            const sessionId = normalizeId(session.id);
            if (!sessionId || sessionId === excludedSessionId) return false;
            if (!areServerProfileIdentifiersEquivalent(normalizeId(session.serverId), serverId)) return false;
            if (!params.accepts(session)) return false;
            return isUserFacingSession(session);
        })
        .sort((left, right) => compareSessionListSessionOrderingKeys(
            buildDestinationOrderingKey(left),
            buildDestinationOrderingKey(right),
            'updated',
        ));
}

export function resolveTranscriptSendToSessionTargets(params: Readonly<{
    sourceSessionId: string;
    sourceServerId: string | null | undefined;
    sessions: ReadonlyArray<TranscriptSendToSessionTargetCandidate>;
}>): ReadonlyArray<TranscriptSendToSessionTargetCandidate> {
    if (!normalizeId(params.sourceSessionId)) return [];
    return resolveQualifiedSessionTargets({
        excludedSessionId: params.sourceSessionId,
        serverId: params.sourceServerId,
        sessions: params.sessions,
        accepts: isWritableSession,
    });
}

export function resolveTranscriptReadableSessionTargets(params: Readonly<{
    excludedSessionId: string;
    serverId: string | null | undefined;
    sessions: ReadonlyArray<TranscriptSendToSessionTargetCandidate>;
}>): ReadonlyArray<TranscriptSendToSessionTargetCandidate> {
    if (!normalizeId(params.excludedSessionId)) return [];
    return resolveQualifiedSessionTargets({
        ...params,
        accepts: isReadableSession,
    });
}

/** A no-invoke reference picker has no source Session to exclude. */
export function resolveReadableSessionPickerTargets(params: Readonly<{
    serverId: string;
    sessions: ReadonlyArray<TranscriptSendToSessionTargetCandidate>;
}>): ReadonlyArray<TranscriptSendToSessionTargetCandidate> {
    return resolveQualifiedSessionTargets({ ...params, excludedSessionId: '', accepts: isReadableSession });
}
