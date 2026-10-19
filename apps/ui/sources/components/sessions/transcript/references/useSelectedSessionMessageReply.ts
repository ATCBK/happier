import * as React from 'react';
import type { Message } from '@happier-dev/session-core/messages';
import { readSessionInputAuthority } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { SessionMessageRefV1Schema, type SessionMessageRefV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageRefV1';
import type { SessionMessageV1 } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import type { SessionMessageReplyReadResultV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import type { CoordinationMessageRefV1 } from '@happier-dev/protocol/discussions/references';
import { projectFollowDeliveryV1, type FollowDeliveryProjectionV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowDeliveryProjectionV1';
import { readSessionMessageReply, readSessionMessageReplyInput } from '@/sync/api/session/sessionMessageReplyApi';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { runWithServerAccountScopeRequestGuard } from '@/sync/runtime/orchestration/serverScopedRpc/serverAccountScopeRequestGuard';

export type SelectedSessionMessageReplyModel = Readonly<{
    request: Readonly<{ sessionId: string; localId: string }>;
    /** Stored content stays in its original envelope for the transcript content owner. */
    requestMessage: SessionMessageV1 | null;
    requestRef: SessionMessageRefV1 | null;
    resultRef: CoordinationMessageRefV1 | null;
    reply: SessionMessageReplyReadResultV1;
    delivery: FollowDeliveryProjectionV1;
}>;

export type SelectedSessionMessageReplyState =
    | Readonly<{ status: 'inactive' }>
    | Readonly<{ status: 'loading' }>
    | Readonly<{ status: 'ready'; refreshing: boolean; model: SelectedSessionMessageReplyModel }>;

const INACTIVE = Object.freeze({ status: 'inactive' } as const);
const LOADING = Object.freeze({ status: 'loading' } as const);

/** Mount only for the selected/open request detail, never once per transcript row. */
export function useSelectedSessionMessageReply(params: Readonly<{
    scope: ServerAccountScope | null;
    sessionId: string;
    message: Message | null;
    active: boolean;
    /** Existing selected-detail invalidation or explicit Retry; no timer/polling owner. */
    refreshKey?: string | number;
}>): SelectedSessionMessageReplyState {
    const message = params.message;
    const selection = React.useMemo(() => {
        if (!params.active || !params.scope || message?.kind !== 'user-text') return null;
        const authority = readSessionInputAuthority(message.meta, 'stored');
        const returned = authority?.v === 1 ? authority.returnedAnswer : undefined;
        const sessionId = returned?.requestSessionId ?? params.sessionId;
        const localId = returned?.requestLocalId ?? message.localId;
        if (!localId) return null;
        const scope = params.scope;
        return { scope, sessionId, localId,
            key: JSON.stringify([scope.serverId, scope.accountId, params.sessionId, message.id, sessionId, localId]) };
    }, [params.active, params.scope?.serverId, params.scope?.accountId, params.sessionId,
        message?.kind, message?.id, message?.localId, message?.meta]);
    const [snapshot, setSnapshot] = React.useState<Readonly<{
        key: string;
        state: Extract<SelectedSessionMessageReplyState, { status: 'ready' }>;
    }> | null>(null);

    React.useEffect(() => {
        if (!selection) {
            setSnapshot(null);
            return;
        }
        const controller = new AbortController();
        let current = true;
        setSnapshot(previous => previous?.key === selection.key
            ? { ...previous, state: { ...previous.state, refreshing: true } } : null);
        const read = { scope: selection.scope, sessionId: selection.sessionId, localId: selection.localId,
            signal: controller.signal, isCurrent: () => current };
        // Keep one captured authority alive until both projections arrive: an
        // earlier successful row must not survive a credential change mid-read.
        void runWithServerAccountScopeRequestGuard({ ...read, staleError: () => new Error('Selected reply scope retired') }, async guard => {
            const guardedRead = { ...read, signal: guard.signal, isCurrent: guard.isCurrent };
            const results = await Promise.all([readSessionMessageReply(guardedRead), readSessionMessageReplyInput(guardedRead)]);
            guard.check();
            return results;
        }).catch(() => [{ v: 1, status: 'unavailable' } as const, null] as const).then(([reply, requestMessage]) => {
            if (!current) return;
            const outcome = reply.status === 'available' ? reply.progress.outcome : undefined;
            const requestRef = requestMessage ? SessionMessageRefV1Schema.parse({ kind: 'session',
                session: { serverId: selection.scope.serverId, sessionId: selection.sessionId }, messageId: requestMessage.id }) : null;
            const resultRef = outcome?.kind !== 'answer' ? null : 'publicationRef' in outcome ? outcome.publicationRef
                : SessionMessageRefV1Schema.parse({ kind: 'session', session: {
                    serverId: selection.scope.serverId, sessionId: outcome.result.sessionId }, messageId: outcome.result.messageId });
            // With no acceptance evidence this projects only the exact outcome;
            // a wake intent alone never proves a wake or an answer.
            const delivery = projectFollowDeliveryV1({ intent: 'wake', decision: { disposition: 'wake' }, replyOutcome: outcome?.kind });
            setSnapshot({ key: selection.key, state: { status: 'ready', refreshing: false, model: {
                request: { sessionId: selection.sessionId, localId: selection.localId }, requestMessage, requestRef, resultRef, reply, delivery,
            } } });
        });
        return () => { current = false; controller.abort(); };
    }, [selection, params.refreshKey]);

    if (!selection) return INACTIVE;
    return snapshot?.key === selection.key ? snapshot.state : LOADING;
}
