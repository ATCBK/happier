import { SessionReadBatchRequestV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { buildSessionMessagesPath } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import type { ServedHomeRequest } from './actionHomesHttpHarness';

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
                return { status: response.status, body: await response.json() };
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
