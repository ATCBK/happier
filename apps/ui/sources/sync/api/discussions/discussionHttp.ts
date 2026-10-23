export type DiscussionHttpTransport = Readonly<{
    request: (path: string, init?: RequestInit) => Promise<Response>;
    assertCurrent?: () => void;
}>;

/** The shared JSON/frame request boundary; server refusals are parsed by the caller. */
export async function requestDiscussionHttp(options: DiscussionHttpTransport, path: string, init: RequestInit): Promise<Response> {
    init.signal?.throwIfAborted();
    options.assertCurrent?.();
    try { return await options.request(path, init); }
    catch {
        // Once request owns the operation, cancellation cannot prove Home did not commit.
        const code = 'outcome_unknown';
        throw Object.assign(new Error(code), { code });
    }
}
