import { SessionMessageReplyReadResultV1Schema, type SessionMessageReplyReadResultV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
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
