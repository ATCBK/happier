import { AuthoringMemoryMutationRequestV1Schema, type AuthoringMemoryContentV1 } from '@happier-dev/protocol/account/authoringMemory';

/** Stateful reserved-row HTTP boundary; crypto, sync and store owners remain real. */
export function createAuthoringMemoryHttpBoundary() {
    const rows = new Map<string, { key: string; revision: number; content: AuthoringMemoryContentV1 | null }>();
    let cursor = 0;
    return {
        reset() { rows.clear(); cursor = 0; },
        async handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response | null> {
            const url = new URL(input instanceof Request ? input.url : String(input));
            const prefix = '/v1/account/authoring-memory';
            if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return null;
            const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
            const account = `${url.origin}|${headers.get('authorization')}|`;
            if (url.pathname === prefix) {
                return Response.json({ rows: [...rows].filter(([id]) => id.startsWith(account)).map(([, row]) => row) });
            }
            const key = decodeURIComponent(url.pathname.slice(prefix.length + 1));
            const id = `${account}${key}`;
            const current = rows.get(id);
            const method = input instanceof Request ? input.method : (init?.method ?? 'GET');
            if (method === 'GET') return Response.json(current
                ? current.content === null
                    ? { status: 'deleted', revision: current.revision }
                    : { status: 'present', revision: current.revision, content: current.content }
                : { status: 'absent' });
            const body = input instanceof Request ? await input.clone().text() : String(init?.body);
            const request = AuthoringMemoryMutationRequestV1Schema.parse(JSON.parse(body));
            if (request.expectedRevision !== (current?.revision ?? 'absent')) {
                return Response.json({ status: 'conflict', revision: current?.revision ?? 0 }, { status: 409 });
            }
            const revision = (current?.revision ?? 0) + 1;
            rows.set(id, { key, revision, content: request.content });
            cursor += 1;
            return Response.json({ status: 'updated', revision, cursor });
        },
    };
}
