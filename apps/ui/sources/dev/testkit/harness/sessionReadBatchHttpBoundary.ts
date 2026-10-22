import { SessionReadBatchRequestV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { buildSessionMessagesPath } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import type { ServedHomeRequest } from './actionHomesHttpHarness';
import type { RuntimeFetch } from '@/utils/system/runtimeFetch';

/** HTTP fixture adapter: single and batch transports use the same external Session facts. */
export function createSessionReadBatchHttpBoundary(route: (request: ServedHomeRequest) => Response | undefined | Promise<Response | undefined>) {
    const componentRequests: ServedHomeRequest[] = [];
    return {
        componentRequests,
        async handle(request: ServedHomeRequest): Promise<Response | undefined> {
            const explicit = await route(request);
            if (explicit || request.path !== '/v2/sessions/read-batch') return explicit;
            const input = SessionReadBatchRequestV1Schema.parse(request.body);
            const read = async (path: string) => {
                const url = new URL(path, request.url.origin);
                const component = { ...request, path: url.pathname, url, method: 'GET', body: undefined };
                componentRequests.push(component);
                const response = await route(component) ?? Response.json({ error: 'not_found' }, { status: 404 });
                // A malformed external fixture stays malformed for the real
                // component parser; it must not throw away sibling outcomes.
                return { status: response.status, body: await response.json().catch(() => null) };
            };
            const results = await Promise.all(input.sessionIds.map(async sessionId => {
                const detail = input.includeSnapshot ? await read(`/v2/sessions/${encodeURIComponent(sessionId)}${input.accessProjectionVersion === 1 ? '?accessProjectionVersion=1' : ''}`) : undefined;
                const admitted = !detail || detail.status === 200;
                const turns = input.includeSnapshot && input.includeTurns !== false && admitted ? await read(`/v1/sessions/${encodeURIComponent(sessionId)}/turns`) : undefined;
                const messages = input.includeMessages && admitted ? await read(buildSessionMessagesPath({ sessionId, scope: 'all', roles: ['user', 'agent', 'event'] })) : undefined;
                return { sessionId, ...(detail ? { detail } : {}), ...(turns ? { turns } : {}), ...(messages ? { messages } : {}) };
            }));
            return Response.json({ results });
        },
    };
}

/** Keep existing external per-Session facts beneath the current batch wire. */
export function createSessionReadBatchFetchBoundary<TResult extends Response | null | undefined>(
    request: (...args: Parameters<RuntimeFetch>) => Promise<TResult>,
): (...args: Parameters<RuntimeFetch>) => Promise<TResult | Response> {
    return async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname !== '/v2/sessions/read-batch' || init?.method !== 'POST') return request(input, init);
        const boundary = createSessionReadBatchHttpBoundary(async component => {
            if (component.path === '/v2/sessions/read-batch') return undefined;
            return await request(component.url.href, { ...init, method: component.method, headers: component.headers,
                signal: component.signal, body: undefined }) ?? undefined;
        });
        return (await boundary.handle({ home: url.origin, accountId: null, url, path: url.pathname,
            method: init.method, headers: new Headers(init.headers), signal: init.signal,
            body: init.body ? JSON.parse(String(init.body)) : undefined }))!;
    };
}
