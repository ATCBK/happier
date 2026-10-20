import type { Session } from '@/sync/domains/state/storageTypes';
import { isTerminalAuthError } from '@/sync/runtime/connectivity/authErrors';
import { fetchSessionByIdWithServerScope, createOperationAccountCurrentnessSource } from './fetchSessionByIdWithServerScope';
import type { ServerAccountRequestAuthority } from './createServerRequestWithServerScope';
import type { SessionByIdPrefetchedRead } from '@/sync/engine/sessions/sessionById';
import { readSessionBatchForAuthority } from './readSessionBatchForAuthority';
import { readSessionDetailAccessProjectionVersion } from '@/sync/api/session/sessionDetailAccessProjection';

type SessionSnapshot = Omit<Session, 'presence'> & { presence?: 'online' | number };

/**
 * Typed, content-free failure from the canonical exact-Home Session reader.
 * UI consumers may distinguish authentication loss, unsupported projections,
 * and retryable transport failure without interpreting transport bodies.
 */
export class SessionSnapshotReadError extends Error {
    constructor(
        readonly errorCode: string,
        readonly httpStatus?: number,
    ) {
        super('Session snapshot unavailable');
        this.name = 'SessionSnapshotReadError';
    }
}

/** Reads a fresh Session without publishing it into the active Home's store. */
export async function readSessionSnapshotForAuthority(params: Readonly<{
    authority: ServerAccountRequestAuthority;
    sessionId: string;
    prefetched?: SessionByIdPrefetchedRead;
    /** Interval consumers need an admitted projection, including a successful empty one. */
    requireTurns?: boolean;
    isCurrent?: () => boolean;
    accountCurrentnessSource?: ReturnType<typeof createOperationAccountCurrentnessSource>;
}>): Promise<Readonly<{ session: SessionSnapshot; callerDataKeyEnvelope: string | null }>> {
    const credentials = params.authority.context.credentials;
    if (!credentials) throw new Error('Session request requires credentials');
    const projection: { session: SessionSnapshot | null } = { session: null };
    const envelopes = new Map<string, string>();
    let result: Awaited<ReturnType<typeof fetchSessionByIdWithServerScope>>;
    try {
        result = await fetchSessionByIdWithServerScope({
            authority: params.authority,
            serverId: params.authority.scope.serverId,
            sessionId: params.sessionId,
            prefetched: params.prefetched,
            includeTurnsProjection: params.requireTurns ? 'required' : undefined,
            activeCredentials: credentials,
            activeRequest: params.authority.request,
            sessionDataKeys: new Map(),
            sessionDataKeyEnvelopes: envelopes,
            applySessions: (sessions) => { projection.session = sessions.find((session) => session.id === params.sessionId) ?? null; },
            log: { log: () => {} },
            isCurrent: params.isCurrent,
            accountCurrentnessSource: params.accountCurrentnessSource,
        });
    } catch (error) {
        if (isTerminalAuthError(error)) {
            throw new SessionSnapshotReadError('unauthorized');
        }
        throw error;
    }
    if (!result.ok || !projection.session) {
        throw new SessionSnapshotReadError(
            result.errorCode ?? 'unavailable',
            result.httpStatus,
        );
    }
    // Hydration may omit failed optional turns. Required evidence must not turn
    // that absence into a reusable successful snapshot on either transport.
    if (params.requireTurns && !projection.session.sessionTurns) {
        throw new SessionSnapshotReadError('turns_unavailable');
    }
    return { session: projection.session, callerDataKeyEnvelope: envelopes.get(params.sessionId) ?? null };
}

type SessionSnapshotResult =
    | Readonly<{ ok: true; snapshot: Awaited<ReturnType<typeof readSessionSnapshotForAuthority>> }>
    | Readonly<{ ok: false; error: unknown }>;

/** Batch only the transport; each result passes through the same currentness, access and crypto owner. */
export async function readSessionSnapshotsForAuthority(params: Readonly<{
    authority: ServerAccountRequestAuthority;
    sessionIds: readonly string[];
    requireTurns?: boolean;
    isCurrent?: () => boolean;
    signal?: AbortSignal;
    accountCurrentnessSource?: ReturnType<typeof createOperationAccountCurrentnessSource>;
}>): Promise<ReadonlyMap<string, SessionSnapshotResult>> {
    const credentials = params.authority.context.credentials;
    if (!credentials) throw new Error('Session request requires credentials');
    const currentness = params.accountCurrentnessSource ?? createOperationAccountCurrentnessSource({ credentials,
        request: params.authority.request, serverId: params.authority.scope.serverId });
    const assertCurrent = () => {
        currentness.assertCurrent();
        if (params.signal?.aborted) throw params.signal.reason ?? new SessionSnapshotReadError('cancelled');
        if (params.isCurrent?.() === false) throw new SessionSnapshotReadError('stale_response');
    };
    try {
        const accessProjectionVersion = readSessionDetailAccessProjectionVersion(params.authority.scope.serverId);
        const rows = await readSessionBatchForAuthority({ ...params, accessProjectionVersion, includeSnapshot: true, includeMessages: false, assertCurrent });
        const results = await Promise.all([...rows].map(async ([sessionId, row]): Promise<readonly [string, SessionSnapshotResult]> => {
            try {
                assertCurrent();
                if (!row.detail) throw new SessionSnapshotReadError('invalid_response');
                const snapshot = await readSessionSnapshotForAuthority({ ...params, sessionId,
                    accountCurrentnessSource: currentness, prefetched: { accessProjectionVersion, detail: row.detail, turns: row.turns } });
                assertCurrent();
                return [sessionId, { ok: true, snapshot }];
            } catch (error) { return [sessionId, { ok: false, error }]; }
        }));
        assertCurrent();
        return new Map(results);
    } finally { if (!params.accountCurrentnessSource) currentness.dispose(); }
}
