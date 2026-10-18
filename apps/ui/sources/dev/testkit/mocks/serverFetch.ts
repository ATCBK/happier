/** Match an endpoint's own contract while permitting transport negotiation parameters. */
export function matchesServerFetchRequest(input: unknown, expectedUrl: string): boolean {
    const expected = new URL(expectedUrl);
    let actual: URL;
    try {
        actual = new URL(String(input));
    } catch {
        return false;
    }
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) return false;
    for (const key of new Set(expected.searchParams.keys())) {
        const expectedValues = expected.searchParams.getAll(key);
        const actualValues = actual.searchParams.getAll(key);
        if (expectedValues.length !== actualValues.length
            || expectedValues.some((value, index) => value !== actualValues[index])) return false;
    }
    return true;
}

export function isServerReachabilityProbeRequest(input: RequestInfo | URL | unknown): boolean {
    const url = String(input);
    return url.endsWith('/health') || url.endsWith('/v1/auth/ping');
}

export function createSuccessfulServerReachabilityProbeResponse(): Response {
    return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

type ServerFetchTestHandler = (
    input: RequestInfo | URL,
    init?: RequestInit,
) => unknown | Promise<unknown>;

export function createServerFetchWithReachabilityProbe(
    handler: ServerFetchTestHandler,
): ServerFetchTestHandler {
    return async (input, init) => {
        if (isServerReachabilityProbeRequest(input)) {
            return createSuccessfulServerReachabilityProbeResponse();
        }
        return await handler(input, init);
    };
}
