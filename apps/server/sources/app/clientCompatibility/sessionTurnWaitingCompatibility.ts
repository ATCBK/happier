import { ACCOUNT_STORED_CONTENT_SESSION_TURN_WAITING_PROTOCOL_VERSION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { readAccountStoredContentCompatibilityForHttpRequest, type AccountStoredContentCompatibilityEvaluation } from './accountStoredContentCompatibility';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** One projection for the released four-state reader, never a second lifecycle writer. */
function projectWaitingRecord(value: unknown): unknown {
    if (!isRecord(value)) return value;
    let projected = value;
    if (value.latestTurnStatus === 'waiting') {
        const { latestReadyEventLocalId: _readyLocalId, ...rest } = value;
        projected = { ...rest, latestTurnStatus: null, latestReadyEventSeq: null,
            latestReadyEventAt: null, thinking: false };
    }
    if (Array.isArray(value.turns)) {
        // Waiting has no terminal result and cannot be represented by the
        // released history union; keep every known turn. External cursor
        // barriers are established from the complete snapshot before projection.
        const turns = value.turns.filter(turn => !isRecord(turn) || turn.status !== 'waiting');
        if (turns.length !== value.turns.length) {
            const { latestTurnId, ...rest } = projected;
            projected = { ...rest, turns,
                ...(typeof latestTurnId === 'string' && turns.some(turn => isRecord(turn) && turn.turnId === latestTurnId)
                    ? { latestTurnId } : {}) };
        }
    }
    return projected;
}

/** V4 is the existing unshipped cumulative reader declaration; older peers stay usable. */
export function projectSessionTurnWaitingCompatibility(
    value: unknown,
    compatibility: Pick<AccountStoredContentCompatibilityEvaluation, 'declaration'>,
): unknown {
    if ((compatibility.declaration?.protocolVersion ?? 0) >= ACCOUNT_STORED_CONTENT_SESSION_TURN_WAITING_PROTOCOL_VERSION) return value;
    if (!isRecord(value)) return value;
    let projected = projectWaitingRecord(value) as Readonly<Record<string, unknown>>;
    if (isRecord(value.session)) projected = { ...projected, session: projectWaitingRecord(value.session) };
    if (Array.isArray(value.sessions)) projected = { ...projected, sessions: value.sessions.map(projectWaitingRecord) };
    if (isRecord(value.body) && value.body.t === 'update-session') {
        projected = { ...projected, body: projectWaitingRecord(value.body) };
    }
    if (isRecord(value.externalShareableSnapshot)) {
        // Cursor barriers were already computed from the complete canonical
        // snapshot. Projection may withhold an unknown history row, never a barrier.
        projected = { ...projected, externalShareableSnapshot: projectWaitingRecord(value.externalShareableSnapshot) };
    }
    return projected;
}

export async function projectSessionTurnWaitingHttpResponse(request: FastifyRequest, _reply: FastifyReply, payload: unknown): Promise<unknown> {
    return projectSessionTurnWaitingCompatibility(payload, readAccountStoredContentCompatibilityForHttpRequest(request));
}
