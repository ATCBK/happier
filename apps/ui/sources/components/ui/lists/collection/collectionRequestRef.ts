import type { SessionPendingRequest, SessionPendingRequestLists } from '@happier-dev/session-core/pending';

export type CollectionSessionRequestRef = Readonly<({ kind: 'permission' } | { kind: 'question' }) & {
    serverId: string;
    sessionId: string;
    requestId: SessionPendingRequest['id'];
    turnId?: SessionPendingRequest['turnId'];
}>;

/** A compact row supplies the request lifetime; its existing Home/Session context qualifies it. */
export type CollectionSessionRequestIdentity = Pick<CollectionSessionRequestRef, 'kind' | 'requestId' | 'turnId'>;

export function createCollectionSessionRequestIdentity(
    request: Pick<SessionPendingRequest, 'kind' | 'id' | 'turnId'>,
): CollectionSessionRequestIdentity {
    return { kind: request.kind === 'user_action' ? 'question' : 'permission', requestId: request.id,
        ...(request.turnId === undefined ? {} : { turnId: request.turnId }) };
}

export function areCollectionSessionRequestIdentitiesEqual(
    left: CollectionSessionRequestIdentity | null | undefined,
    right: CollectionSessionRequestIdentity | null | undefined,
): boolean {
    return left === right || (left == null && right == null)
        || (left != null && right != null && left.kind === right.kind
            && left.requestId === right.requestId && left.turnId === right.turnId);
}

/** An address only. Bodies and response authority remain with their existing domain owners. */
export type CollectionRequestRef = CollectionSessionRequestRef
    | Readonly<{ kind: 'approval'; serverId: string; artifactId: string }>
    | Readonly<{ kind: 'workflow_hold'; serverId: string; runId: string; invocationRecordId: string }>;

export function collectionRequestRefKey(ref: CollectionRequestRef): string {
    switch (ref.kind) {
        case 'approval': return JSON.stringify([ref.kind, ref.serverId, ref.artifactId]);
        case 'workflow_hold': return JSON.stringify([ref.kind, ref.serverId, ref.runId, ref.invocationRecordId]);
        default: return JSON.stringify([ref.kind, ref.serverId, ref.sessionId, ref.requestId, ref.turnId ?? null]);
    }
}

export function createCollectionSessionRequestRef(
    target: Readonly<{ serverId: string; sessionId: string }>,
    request: Pick<SessionPendingRequest, 'kind' | 'id' | 'turnId'> | CollectionSessionRequestIdentity,
): CollectionSessionRequestRef {
    const identity = 'requestId' in request ? request : createCollectionSessionRequestIdentity(request);
    return { ...target, kind: identity.kind, requestId: identity.requestId,
        ...(identity.turnId === undefined ? {} : { turnId: identity.turnId }) };
}

export type CollectionSessionRequestResolution =
    | Readonly<{ kind: 'current'; request: SessionPendingRequest }>
    | Readonly<{ kind: 'replaced'; replacement: CollectionSessionRequestRef }>
    | Readonly<{ kind: 'settled' | 'unavailable' }>;

/** A same-id request from another turn must be reviewed again, never inherit the old answer. */
export function resolveCollectionSessionRequest(
    ref: CollectionSessionRequestRef,
    target: Readonly<{ serverId: string; sessionId: string }>,
    pending: SessionPendingRequestLists,
): CollectionSessionRequestResolution {
    if (ref.serverId !== target.serverId || ref.sessionId !== target.sessionId) return { kind: 'unavailable' };
    const requests = ref.kind === 'permission' ? pending.permissionRequests : pending.userActionRequests;
    const request = requests.find(candidate => candidate.id === ref.requestId);
    if (!request) return { kind: 'settled' };
    if (request.turnId !== ref.turnId) return { kind: 'replaced', replacement: createCollectionSessionRequestRef(target, request) };
    return { kind: 'current', request };
}
