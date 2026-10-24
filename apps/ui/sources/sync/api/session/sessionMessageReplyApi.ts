import { SessionMessageReplyReadResultV1Schema, SessionMessageReplyReadBatchResponseV1Schema,
    type SessionMessageReplyReadResultV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { SessionMessageV1Schema, type SessionMessageV1 } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { PendingLocalIdSchema } from '@happier-dev/protocol/sessions/pending/pendingLocalId';
import { SessionIdSchema } from '@happier-dev/protocol/sessions/idsV1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { runWithServerAccountScopeRequestGuard } from '@/sync/runtime/orchestration/serverScopedRpc/serverAccountScopeRequestGuard';

const UNAVAILABLE = Object.freeze({ v: 1, status: 'unavailable' } as const);

type SessionMessageInputReadParams = Readonly<{
    scope: ServerAccountScope;
    sessionId: string;
    localId: string;
    isCurrent?: () => boolean;
    signal?: AbortSignal;
}>;

async function readOriginalInputProjection<TResult>(params: SessionMessageInputReadParams, suffix: string,
    unavailable: TResult, project: (payload: unknown) => TResult): Promise<TResult> {
    const sessionId = SessionIdSchema.safeParse(params.sessionId);
    const localId = PendingLocalIdSchema.safeParse(params.localId);
    if (!sessionId.success || !localId.success) return unavailable;
    try {
        return await runWithServerAccountScopeRequestGuard({ ...params, staleError: () => new Error('Reply scope retired') }, async guard => {
            guard.check();
            return await runWithServerRequestAuthorityForServerAccountScope({ scope: params.scope,
                activeRequest: async () => { throw new Error('Reply reads require captured Account authority'); },
            }, async authority => {
                guard.check();
                const response = await authority.request(`/v2/sessions/${encodeURIComponent(sessionId.data)}/messages/by-local-id/${encodeURIComponent(localId.data)}${suffix}`,
                    { method: 'GET', signal: guard.signal }, { retry: 'none' });
                guard.check();
                if (!response.ok) return unavailable;
                const payload: unknown = await response.json();
                guard.check();
                return project(payload);
            });
        });
    } catch {
        return unavailable;
    }
}

/** Explicit exact-input read; the original input owner remains the reply authority. */
export function readSessionMessageReply(params: SessionMessageInputReadParams): Promise<SessionMessageReplyReadResultV1> {
    return readOriginalInputProjection<SessionMessageReplyReadResultV1>(params, '/reply', UNAVAILABLE, payload => {
        const parsed = SessionMessageReplyReadResultV1Schema.safeParse(payload);
        return parsed.success ? parsed.data : UNAVAILABLE;
    });
}

/** Resolve an input lookup key to its actual committed row, using the canonical row reader. */
export function readSessionMessageReplyInput(params: SessionMessageInputReadParams): Promise<SessionMessageV1 | null> {
    return readOriginalInputProjection<SessionMessageV1 | null>(params, '', null, payload => {
        const message = payload !== null && typeof payload === 'object' && 'message' in payload ? payload.message : undefined;
        const parsed = SessionMessageV1Schema.safeParse(message);
        return parsed.success && parsed.data.localId === params.localId ? parsed.data : null;
    });
}

export type SessionMessageReplyKey = Readonly<{ sessionId: string; localId: string }>;
export function sessionMessageReplyKey(input: SessionMessageReplyKey): string { return JSON.stringify([input.sessionId, input.localId]); }

type BatchBorrower = Readonly<{ keys: readonly SessionMessageReplyKey[]; isCurrent?: () => boolean;
    resolve: (rows: ReadonlyMap<string, SessionMessageReplyReadResultV1>) => void }>;
// In-flight transport collection only: no result cache or second reply store. Synchronous row demand shares one physical read.
const pendingBatches = new Map<string, { scope: ServerAccountScope; borrowers: BatchBorrower[] }>();

export function readSessionMessageReplies(params: Readonly<{
    scope: ServerAccountScope; requests: readonly SessionMessageReplyKey[]; isCurrent?: () => boolean;
}>): Promise<ReadonlyMap<string, SessionMessageReplyReadResultV1>> {
    if (!params.requests.length || params.isCurrent?.() === false) return Promise.resolve(new Map());
    const keys = params.requests.map(key => ({ sessionId: SessionIdSchema.parse(key.sessionId), localId: PendingLocalIdSchema.parse(key.localId) }));
    const scopeKey = JSON.stringify([params.scope.serverId, params.scope.accountId]);
    let batch = pendingBatches.get(scopeKey);
    if (!batch) {
        batch = { scope: params.scope, borrowers: [] };
        pendingBatches.set(scopeKey, batch);
        const collected = batch;
        void Promise.resolve().then(async () => {
            pendingBatches.delete(scopeKey);
            const requests = [...new Map(collected.borrowers.filter(borrower => borrower.isCurrent?.() !== false)
                .flatMap(borrower => borrower.keys.map(key => [sessionMessageReplyKey(key), key] as const))).values()];
            let rows = new Map<string, SessionMessageReplyReadResultV1>();
            try {
                if (requests.length) rows = await runWithServerAccountScopeRequestGuard({ scope: collected.scope,
                    staleError: () => new Error('Reply batch scope retired') }, guard =>
                    runWithServerRequestAuthorityForServerAccountScope({ scope: collected.scope,
                        activeRequest: async () => { throw new Error('Reply batch requires captured Account authority'); },
                    }, async authority => {
                        guard.check();
                        const response = await authority.request('/v2/sessions/messages/replies/read-batch', { method: 'POST',
                            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requests }), signal: guard.signal }, { retry: 'none' });
                        if (!response.ok) return new Map<string, SessionMessageReplyReadResultV1>();
                        const payload: unknown = await response.json();
                        guard.check();
                        const parsed = SessionMessageReplyReadBatchResponseV1Schema.safeParse(payload);
                        if (!parsed.success) return new Map<string, SessionMessageReplyReadResultV1>();
                        const allowed = new Set(requests.map(sessionMessageReplyKey));
                        return new Map(parsed.data.results.filter(row => allowed.has(sessionMessageReplyKey(row)))
                            .map(row => [sessionMessageReplyKey(row), row.reply]));
                    }));
            } catch { /* Missing operation, access loss and retired authority stay unavailable. */ }
            for (const borrower of collected.borrowers) borrower.resolve(borrower.isCurrent?.() === false ? new Map() : new Map(
                borrower.keys.map(key => [sessionMessageReplyKey(key), rows.get(sessionMessageReplyKey(key)) ?? UNAVAILABLE])));
        });
    }
    const currentBatch = batch;
    return new Promise(resolve => currentBatch.borrowers.push({ keys, isCurrent: params.isCurrent, resolve }));
}
