import { SessionReadBatchRequestV1Schema, SessionReadBatchResponseV1Schema,
    type SessionReadBatchResponseV1 } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { createServerHttpRequestBodyItemBudgetV1 } from '@happier-dev/protocol/server/http/requestBodyBoundsV1';
import type { ServerAccountRequestAuthority } from './createServerRequestWithServerScope';

/** Finite exact-Account transport batch. Admission and opening remain with the component readers. */
export async function readSessionBatchForAuthority(params: Readonly<{
    authority: ServerAccountRequestAuthority;
    sessionIds: readonly string[];
    includeSnapshot: boolean;
    includeMessages: boolean;
    accessProjectionVersion?: 1;
    signal?: AbortSignal;
    assertCurrent: () => void;
}>): Promise<ReadonlyMap<string, SessionReadBatchResponseV1['results'][number]>> {
    const assertCurrent = () => {
        params.assertCurrent();
        // Hermes AbortSignal implementations need not expose throwIfAborted.
        if (params.signal?.aborted) throw params.signal.reason ?? Object.assign(new Error('Session batch cancelled'), { name: 'AbortError' });
    };
    const result = new Map<string, SessionReadBatchResponseV1['results'][number]>();
    const ids = [...new Set(params.sessionIds)];
    const emptyBody = { sessionIds: [] as string[], includeSnapshot: params.includeSnapshot, includeMessages: params.includeMessages,
        ...(params.accessProjectionVersion === 1 ? { accessProjectionVersion: 1 as const } : {}) };
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
        assertCurrent();
        const input = SessionReadBatchRequestV1Schema.parse({ ...emptyBody, sessionIds });
        const response = await params.authority.request('/v2/sessions/read-batch', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: params.signal,
        });
        assertCurrent();
        if (!response.ok) throw Object.assign(new Error('Session batch unavailable'), { httpStatus: response.status });
        const body = SessionReadBatchResponseV1Schema.parse(await response.json());
        assertCurrent();
        const expected = new Set(sessionIds);
        for (const row of body.results) {
            if (!expected.delete(row.sessionId)
                || (params.includeSnapshot && !row.detail)
                || (params.includeSnapshot && row.detail?.status === 200 && !row.turns)
                || (params.includeMessages && (!params.includeSnapshot || row.detail?.status === 200) && !row.messages)) {
                throw new Error('Invalid Session batch response');
            }
            result.set(row.sessionId, row);
        }
        if (expected.size) throw new Error('Incomplete Session batch response');
    }
    return result;
}
