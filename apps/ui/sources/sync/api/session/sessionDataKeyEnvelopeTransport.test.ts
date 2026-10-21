import { afterEach, expect, it, vi } from 'vitest';
import { createCapturedServerReadTransport } from '@/sync/runtime/orchestration/serverScopedRpc/capturedServerReadTransport';
import type { ServerAccountRequestAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { runWithServerAccountScopeRequestGuard } from '@/sync/runtime/orchestration/serverScopedRpc/serverAccountScopeRequestGuard';
import { createEnvelopeTransport, type SessionDataKeyEnvelopeCollectionState } from './sessionDataKeyEnvelopeTransport';
import { SessionAccessApiError } from './sessionAccessHttpFailure';

const runtimeFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/system/runtimeFetch', () => ({ runtimeFetch: (...args: unknown[]) => runtimeFetch(...args) }));
afterEach(() => runtimeFetch.mockReset());
const scope = { serverId: 'home', accountId: 'account' };

function authority(): ServerAccountRequestAuthority {
    return { scope, context: { scope: 'scoped', targetServerId: 'home', targetServerUrl: 'https://home.example.test',
        targetAccountId: 'account', token: 'token', credentials: { token: 'token' }, encryption: null, timeoutMs: 30_000 },
        request: async (path, init) => await runtimeFetch(`https://home.example.test${path}`, init), release: async () => {},
        readTransport: createCapturedServerReadTransport({ serverId: 'home', profile: { serverUrl: 'https://home.example.test' },
            credentials: { token: 'token' } }) };
}

function withClient<T>(read: (client: ReturnType<typeof createEnvelopeTransport>) => Promise<T>,
    options: { signal?: AbortSignal; state?: SessionDataKeyEnvelopeCollectionState; isCurrent?: () => boolean } = {}) {
    return runWithServerAccountScopeRequestGuard({ scope, ...options, staleError: () => new SessionAccessApiError('scope_changed') },
        async guard => await read(createEnvelopeTransport({ authority: authority(), guard, sessionId: 'same' }, options.state)));
}

it('shares neutral page acquisition while a cancelled borrower leaves a current borrower alive', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const signals: Array<AbortSignal | null | undefined> = [];
    runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
        if (new URL(String(url)).pathname === '/v1/auth/ping') return Response.json({});
        signals.push(init?.signal);
        await Promise.race([held, new Promise<never>((_resolve, reject) => init?.signal?.addEventListener('abort',
            () => reject(new DOMException('Aborted', 'AbortError')), { once: true }))]);
        return Response.json({ status: 'not_required' });
    });
    const abort = new AbortController();
    const first = withClient(client => client.fetchPage(null), { signal: abort.signal }).catch(() => 'cancelled');
    const survivor = withClient(client => client.fetchPage(null));
    await vi.waitFor(() => expect(signals.length).toBeGreaterThan(0));
    abort.abort();
    await expect(first).resolves.toBe('cancelled');
    const physicalCancelled = signals.at(-1)?.aborted;
    release();
    await expect(survivor).resolves.toEqual({ status: 'not_required' });
    expect(physicalCancelled).toBe(false);
    expect(signals).toHaveLength(1);
});

it('separates audience/cursor and makes a settled PATCH forget pre-write pending observations', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let gets = 0;
    runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
        if (new URL(String(url)).pathname === '/v1/auth/ping') return Response.json({});
        if (init?.method === 'PATCH') return Response.json({ appliedCount: 0 });
        gets += 1;
        if (gets === 1) await held;
        return Response.json({ status: 'not_required' });
    });
    const old = withClient(client => client.fetchPage(null));
    try {
        await vi.waitFor(() => expect(gets).toBe(1));
        await withClient(client => client.patchPage({ entries: [] }));
        const current = withClient(client => client.fetchPage(null));
        await vi.waitFor(() => expect(gets).toBe(2));
        release();
        await Promise.all([old, current]);
        const { encodeSessionDataKeyEnvelopeCursorV1 } = await import('@happier-dev/protocol/sessions/encryption/sessionDataKeyEnvelopes');
        await Promise.all([withClient(client => client.fetchPage(null)), withClient(client => client.fetchPage(null), { state: 'all' }),
            withClient(client => client.fetchPage(encodeSessionDataKeyEnvelopeCursorV1('recipient')))]);
        expect(gets).toBe(5);
    } finally { release(); await old; }
});
