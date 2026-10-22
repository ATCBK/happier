import { SessionReadBatchRequestV1Schema, SessionReadBatchResponseV1Schema,
    type SessionReadBatchResponseV1 } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { createServerHttpRequestBodyItemBudgetV1 } from '@happier-dev/protocol/server/http/requestBodyBoundsV1';
import type { ServerAccountRequestAuthority } from './createServerRequestWithServerScope';
import type { CapturedServerReadTransport } from './capturedServerReadTransport';
import { createScopedBatchResolutionSingleFlight } from './scopedResolutionSingleFlight';

type SessionReadPart = SessionReadBatchResponseV1['results'][number];
const sessionParts = createScopedBatchResolutionSingleFlight<SessionReadPart>();

export class SessionPartsHttpError extends Error {
    constructor(readonly httpStatus: number, readonly body: unknown) {
        super('Session batch unavailable');
    }
}

/** A response arrived, but cannot supply the exact Session parts requested. */
export class SessionPartsInvalidResponseError extends Error {
    constructor() { super('Invalid Session batch response'); }
}

export type SessionPartsReadOptions = Readonly<{
    request: (path: string, init: RequestInit) => Promise<Response>;
    readTransport?: CapturedServerReadTransport;
    sessionIds: readonly string[];
    includeSnapshot: boolean;
    includeTurns?: boolean;
    includeMessages: boolean;
    accessProjectionVersion?: 1;
    signal?: AbortSignal;
    fresh?: boolean;
    retry?: 'none';
    assertCurrent: () => void;
}>;

/** The one parsed Session-parts acquisition owner; admission and opening remain per borrower. */
export function prepareSessionPartsRead(params: Omit<SessionPartsReadOptions, 'sessionIds'>) {
    const assertCurrent = () => {
        params.assertCurrent();
        // Hermes AbortSignal implementations need not expose throwIfAborted.
        if (params.signal?.aborted) throw params.signal.reason ?? Object.assign(new Error('Session batch cancelled'), { name: 'AbortError' });
    };
    assertCurrent();
    const demand = SessionReadBatchRequestV1Schema.parse({ sessionIds: [], includeSnapshot: params.includeSnapshot,
        includeMessages: params.includeMessages, includeTurns: params.includeTurns,
        accessProjectionVersion: params.accessProjectionVersion });
    const includeTurns = demand.includeSnapshot && demand.includeTurns !== false;
    const emptyBody = { ...demand, includeTurns };
    const transport = params.readTransport;
    const transportKey = transport?.key;
    const scope = transport?.scope ?? transportKey;
    const reservation = sessionParts.reserve(JSON.stringify([transportKey ?? null, params.includeSnapshot, includeTurns, params.includeMessages,
        params.accessProjectionVersion ?? null, params.retry ?? null]), { scope, signal: params.signal, fresh: params.fresh || !transport });
    return {
        release: reservation.release,
        async read(sessionIds: readonly string[]): Promise<ReadonlyMap<string, SessionReadPart>> {
            try {
                assertCurrent();
                return await reservation.run(sessionIds, async (ids, signal) => {
                    const result = new Map<string, SessionReadPart>();
                    let budget = createServerHttpRequestBodyItemBudgetV1(emptyBody);
                    const batches: string[][] = [];
                    let batch: string[] = [];
                    for (const id of ids) {
                        if (!budget.tryAdmit(id)) {
                            if (!batch.length) throw new Error('Session id exceeds the HTTP request body limit');
                            batches.push(batch);
                            batch = [];
                            budget = createServerHttpRequestBodyItemBudgetV1(emptyBody);
                            if (!budget.tryAdmit(id)) throw new Error('Session id exceeds the HTTP request body limit');
                        }
                        batch.push(id);
                    }
                    if (batch.length) batches.push(batch);
                    for (const sessionIds of batches) {
                        const input = SessionReadBatchRequestV1Schema.parse({ ...emptyBody, sessionIds });
                        const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal };
                        const consume = async (response: Response) => {
                            const payload: unknown = await response.json().catch(() => null);
                            if (!response.ok) throw new SessionPartsHttpError(response.status, payload);
                            const parsed = SessionReadBatchResponseV1Schema.safeParse(payload);
                            if (!parsed.success) throw new SessionPartsInvalidResponseError();
                            return parsed.data;
                        };
                        const body = transport
                            ? await transport.read('/v2/sessions/read-batch', init, params.retry ? { retry: params.retry } : undefined, consume)
                            : await consume(await params.request('/v2/sessions/read-batch', init));
                        const expected = new Set(sessionIds);
                        for (const row of body.results) {
                            if (!expected.delete(row.sessionId)
                                || (params.includeSnapshot && !row.detail)
                                || (includeTurns && row.detail?.status === 200 && !row.turns)
                                || (params.includeMessages && (!params.includeSnapshot || row.detail?.status === 200) && !row.messages)) {
                                throw new SessionPartsInvalidResponseError();
                            }
                            result.set(row.sessionId, row);
                        }
                        if (expected.size) throw new SessionPartsInvalidResponseError();
                    }
                    return result;
                });
            } finally {
                reservation.release();
                assertCurrent();
            }
        },
    };
}

export async function readSessionParts(params: SessionPartsReadOptions): Promise<ReadonlyMap<string, SessionReadPart>> {
    return await prepareSessionPartsRead(params).read(params.sessionIds);
}

/** Finite exact-Account batch facade; all projections use the same pending-only owner. */
export function readSessionBatchForAuthority(params: Omit<SessionPartsReadOptions, 'request' | 'readTransport'> & Readonly<{
    authority: ServerAccountRequestAuthority;
}>): Promise<ReadonlyMap<string, SessionReadPart>> {
    return readSessionParts({ ...params, request: params.authority.request, readTransport: params.authority.readTransport });
}

export function resetSessionPartsReadsForTests(): void { sessionParts.reset(); }
