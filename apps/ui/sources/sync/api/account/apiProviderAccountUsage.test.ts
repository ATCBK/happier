import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { ConnectedServiceQuotaGetResultV1 } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { sealProviderAccountUsageSnapshot, openSealedProviderAccountUsageSnapshot } from '@happier-dev/protocol/connect/accountUsage';
import { isServerFetchConnectivityProbeRequest } from '@/dev/testkit/mocks/serverFetch';
import {
    ProviderAccountUsageSnapshotV1Schema,
    buildProviderAccountUsageRecordId,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol/connect/account-usage-primitives';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

const credentials: AuthCredentials = { token: 't', secret: 's' };

async function activateTestHome() {
    const { upsertAndActivateServer, setAccountServiceEndpoint } = await import('@/sync/domains/server/serverRuntime');
    // This node harness has no browser sessionStorage; use the durable selection.
    await upsertAndActivateServer({ serverUrl: 'https://api.example.test', scope: 'device' });
    await setAccountServiceEndpoint({ url: 'https://api.example.test', displayName: 'Test service', source: 'user' });
}

function makeSnapshot(): ProviderAccountUsageSnapshotV1 {
    const recordKey = {
        providerId: 'codex',
        accountSubjectId: 'acct_stable',
        subjectKind: 'account',
        quotaScope: 'account',
    } satisfies ProviderAccountUsageSnapshotV1['recordKey'];
    return ProviderAccountUsageSnapshotV1Schema.parse({
        v: 1,
        recordId: buildProviderAccountUsageRecordId(recordKey),
        recordKey,
        providerId: 'codex',
        accountSubject: {
            kind: 'providerSubject',
            id: 'acct_stable',
        },
        observedAtMs: 1,
        fetchedAtMs: 1,
        staleAfterMs: 2,
        source: 'runtimeSignal',
        confidence: 'confirmed',
        state: 'loaded_data',
        planLabel: null,
        accountLabel: null,
        meters: [],
        recoveryCreditDetails: { saved: { remainingCount: 2, appliesToProviderLimitIds: ['seven_day'], unavailableReason: 'paused' } },
    });
}

async function loadApi() {
    try {
        return await import('./apiProviderAccountUsage');
    } catch (error) {
        expect.fail(`canonical provider account usage API is missing: ${String(error)}`);
    }
}

describe('apiProviderAccountUsage', () => {
    it.each(['plain', 'e2ee'] as const)('releases the event loop before publishing a large admitted %s history page', async accountMode => {
        const { DEFAULT_CRYPTO_BATCH_YIELD_CHUNK_SIZE } = await import('@/sync/encryption/cryptoBatchYield');
        const { sealProviderAccountUsageSnapshot } = await import('@happier-dev/protocol/connect/accountUsage');
        const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const };
        const samples = Array.from({ length: DEFAULT_CRYPTO_BATCH_YIELD_CHUNK_SIZE * 3 }, (_, index) => ({
            ...makeSnapshot(), observedAtMs: index + 1, fetchedAtMs: index + 1, planLabel: String(index),
        }));
        const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
        const record = (snapshot: ProviderAccountUsageSnapshotV1) => {
            const sealed = accountMode === 'e2ee' ? sealProviderAccountUsageSnapshot({ snapshot, material,
                randomBytes: length => new Uint8Array(length).fill(9) }) : null;
            return { content: sealed ? { t: 'encrypted', c: sealed.ciphertext, recoveryCreditDetails: sealed.recoveryCreditDetails }
                : { t: 'plain', v: snapshot }, metadata: { fetchedAt: snapshot.fetchedAtMs, staleAfterMs: 2, status: 'ok' }, sources: [source] };
        };
        let heartbeat = false;
        let heartbeatAtPublication = false;
        let abortDuringOpening = false;
        const controller = new AbortController();
        let releaseHeartbeat!: () => void;
        const heartbeatFinished = new Promise<void>(resolve => { releaseHeartbeat = resolve; });
        const request = vi.fn(async (path: string) => {
            if (path.includes('/history')) {
                const response = Response.json({ entries: samples.map(snapshot => ({ id: String(snapshot.observedAtMs),
                    observedAtMs: snapshot.observedAtMs, record: record(snapshot) })), nextCursor: null });
                // A real event-loop task represents input/layout waiting behind the opening batch.
                setTimeout(() => {
                    heartbeat = true;
                    if (abortDuringOpening) controller.abort();
                    releaseHeartbeat();
                }, 0);
                return response;
            }
            const current = samples.at(-1)!;
            return Response.json(path.includes('/sources/resolve') ? { source, recordId: current.recordId,
                providerAccountId: current.recordKey.accountSubjectId, fetchedAt: current.fetchedAtMs, staleAfterMs: 2 } : record(current));
        });
        try {
            const { getProviderAccountUsageQuota } = await loadApi();
            const started = performance.now();
            const result = await getProviderAccountUsageQuota({ token: 'plain-token' }, { source,
                history: { range: { startAtMs: 0, endAtMs: samples.length + 1 }, pageSize: samples.length } }, {
                accountMode, material: accountMode === 'e2ee' ? material : undefined, request, nowMs: samples.length,
                includePendingWork: false, readAllHistory: { onProgress(value) {
                    if (value.history?.entries.length === samples.length) heartbeatAtPublication = heartbeat;
                } },
            });
            console.info(`history owner benchmark ${accountMode}: ${samples.length} entries, ${(performance.now() - started).toFixed(1)} ms, event-loop released=${heartbeatAtPublication}`);
            expect(result.history?.entries.map(entry => entry.snapshot)).toEqual(samples);
            expect(heartbeatAtPublication).toBe(true);
            abortDuringOpening = true;
            let cancelledHistoryPublished = false;
            await expect(getProviderAccountUsageQuota({ token: 'plain-token' }, { source,
                history: { range: { startAtMs: 0, endAtMs: samples.length + 1 }, pageSize: samples.length } }, {
                accountMode, material: accountMode === 'e2ee' ? material : undefined, request, nowMs: samples.length,
                signal: controller.signal, includePendingWork: false,
                readAllHistory: { onProgress(value) { if (value.history?.entries.length) cancelledHistoryPublished = true; } },
            })).rejects.toMatchObject({ name: 'AbortError' });
            expect(cancelledHistoryPublished).toBe(false);
        } finally { await heartbeatFinished; }
    });
    it.each(['plain', 'e2ee'] as const)('progressively drains accepted %s history with growing pages while opening current and Pending only once', async accountMode => {
        const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const };
        const samples = Array.from({ length: 10 }, (_, index) => ({ ...makeSnapshot(), fetchedAtMs: index + 1,
            observedAtMs: index + 1, planLabel: index < 5 ? 'Standard' : 'Premium' }));
        const current = samples.at(-1)!;
        const { sealProviderAccountUsageSnapshot } = await import('@happier-dev/protocol/connect/accountUsage');
        const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
        const record = (snapshot: ProviderAccountUsageSnapshotV1) => {
            const sealed = accountMode === 'e2ee' ? sealProviderAccountUsageSnapshot({ snapshot, material,
                randomBytes: length => new Uint8Array(length).fill(9) }) : null;
            return { content: sealed ? { t: 'encrypted', c: sealed.ciphertext, recoveryCreditDetails: sealed.recoveryCreditDetails }
                : { t: 'plain', v: snapshot }, metadata: { fetchedAt: snapshot.fetchedAtMs, staleAfterMs: 2, status: 'ok' }, sources: [source] };
        };
        const seen = new Set<string>();
        const request = vi.fn(async (path: string) => {
            if (!path.includes('/history')) {
                // Repeated source/current/Pending reads are refused at the real transport boundary.
                const key = path.split('?')[0]!;
                if (seen.has(key)) return new Response('repeat refused', { status: 403 });
                seen.add(key);
            }
            if (path.includes('/history')) {
                const query = JSON.parse(new URL(path, 'https://qa.test').searchParams.get('query')!);
                const start = query.history.cursor ? Number(query.history.cursor.id) + 1 : 0;
                const entries = samples.slice(start, start + query.history.pageSize).map((snapshot, index) => ({
                    id: String(start + index), observedAtMs: snapshot.fetchedAtMs, record: record(snapshot) }));
                const last = entries.at(-1)!;
                return Response.json({ entries, nextCursor: start + entries.length < samples.length
                    ? { id: last.id, observedAtMs: last.observedAtMs } : null });
            }
            return Response.json(path.includes('/sources/resolve') ? { source, recordId: current.recordId,
                providerAccountId: current.recordKey.accountSubjectId, fetchedAt: 10, staleAfterMs: 2 }
                : path.includes('/reset-starts/read') ? { entries: [] } : record(current));
        });
        const progress: ConnectedServiceQuotaGetResultV1[] = [];
        let releasePrice!: () => void;
        const priceGate = new Promise<void>(resolve => { releasePrice = resolve; });
        const options = { accountMode, material: accountMode === 'e2ee' ? material : undefined, request, nowMs: 10,
            readEnteredMonthlyPrice: async () => { await priceGate; return undefined; },
            readAllHistory: { onProgress: (value: (typeof progress)[number]) => { progress.push(value); releasePrice(); } } };
        const { getProviderAccountUsageQuota } = await loadApi();
        const result = await getProviderAccountUsageQuota({ token: 'plain-token' }, { source,
            history: { range: { startAtMs: 0, endAtMs: 11 }, pageSize: 1 } }, options);
        expect(progress[0]).toMatchObject({ current });
        expect(progress[0]?.history).toBeUndefined();
        expect(progress.some(value => value.history?.nextCursor != null)).toBe(true);
        const historyProgress = progress.filter(value => value.history?.entries.length);
        const firstWitness = historyProgress[0]!.history!.entries[0]!;
        // The HTTP opener already admitted this immutable witness. Later pages
        // must not clone every unchanged accepted snapshot on each publication.
        expect(historyProgress.length).toBeGreaterThan(1);
        for (const value of historyProgress.slice(1)) {
            expect(value.history!.entries.find(entry => entry.id === firstWitness.id)?.snapshot).toBe(firstWitness.snapshot);
        }
        expect(result.history?.entries.map(entry => entry.id)).toEqual(['0', '4', '5', '9']);
        expect(result.history?.nextCursor).toBeNull();
        expect(result.waitingWork).toEqual({ status: 'available', entries: [] });
    });
    it('stops a progressive history producer after its parallel price read fails', async () => {
        const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
        const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const };
        const snapshot = makeSnapshot();
        const record = { content: { t: 'plain', v: snapshot }, metadata: { fetchedAt: 1, staleAfterMs: 2, status: 'ok' }, sources: [source] };
        const history = createDeferred<Response>();
        const price = createDeferred<undefined>();
        const enteredHistory = createDeferred<void>();
        const consumedHistory = createDeferred<void>();
        const page = { entries: [{ id: 'first', observedAtMs: 1, record }], nextCursor: { id: 'first', observedAtMs: 1 } };
        const lateHistory: ConnectedServiceQuotaGetResultV1[] = [];
        let settled = false;
        let continuationIssued = false;
        const request = async (path: string) => {
            if (path.includes('/history')) {
                const query = JSON.parse(new URL(path, 'https://qa.test').searchParams.get('query')!);
                if (query.history.cursor) { continuationIssued = true; return Response.json({ entries: [], nextCursor: null }); }
                enteredHistory.resolve();
                const response = await history.promise;
                const json = response.json.bind(response);
                response.json = async () => { const result = await json(); consumedHistory.resolve(); return result; };
                return response;
            }
            return Response.json(path.includes('/sources/resolve') ? { source, recordId: snapshot.recordId,
                providerAccountId: snapshot.recordKey.accountSubjectId, fetchedAt: 1, staleAfterMs: 2 } : record);
        };
        const { getProviderAccountUsageQuota } = await loadApi();
        const reading = getProviderAccountUsageQuota({ token: 'plain-token' }, { source,
            history: { range: { startAtMs: 0, endAtMs: 2 }, pageSize: 1 } }, {
            accountMode: 'plain', request, nowMs: 1, includePendingWork: false,
            readEnteredMonthlyPrice: () => price.promise,
            readAllHistory: { onProgress(value) { if (settled && value.history) lateHistory.push(value); } },
        });
        const rejected = expect(reading).rejects.toMatchObject({ message: 'price authority unavailable' });
        try {
            await enteredHistory.promise;
            price.reject(new Error('price authority unavailable'));
            await rejected;
            settled = true;
            history.resolve(Response.json(page));
            await consumedHistory.promise;
            // Flush the completed HTTP body's microtasks and the page-opening task.
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            expect(lateHistory).toEqual([]);
            expect(continuationIssued).toBe(false);
        } finally { history.resolve(Response.json(page)); price.resolve(undefined); await reading.catch(() => {}); }
    });
    it('reads reset admission facts without unrelated Account-wide Pending work', async () => {
        const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const };
        const snapshot = makeSnapshot();
        const forbiddenRequests: string[] = [];
        const request = vi.fn(async (path: string) => {
            if (path.includes('/reset-starts/read')) {
                forbiddenRequests.push(path);
                return new Response(JSON.stringify({ error: 'denied' }), { status: 403 });
            }
            return new Response(JSON.stringify(path.includes('/sources/resolve')
                ? { source, recordId: snapshot.recordId, providerAccountId: snapshot.recordKey.accountSubjectId, fetchedAt: 1, staleAfterMs: 2 }
                : { content: { t: 'plain', v: snapshot }, metadata: { fetchedAt: 1, staleAfterMs: 2, status: 'ok' }, sources: [source] }), { status: 200 });
        });
        const { getProviderAccountUsageQuota } = await loadApi();
        const result = await getProviderAccountUsageQuota({ token: 'plain-token' }, { source }, {
            accountMode: 'plain', request, nowMs: 1, includePendingWork: false,
        });
        expect(result.current).toEqual(snapshot);
        // The signed reset-admission grant authorizes only B; attempting the
        // Account-wide POST would broaden that authority even if it were denied.
        expect(forbiddenRequests).toEqual([]);
    });
    it.each(['pending', 'witness'] as const)('samples completion time after held %s HTTP without changing explicit as-of reads', async held => {
        const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const };
        const witness = ProviderAccountUsageSnapshotV1Schema.parse({ ...makeSnapshot(), observedAtMs: 500, fetchedAtMs: 500, staleAfterMs: 2000, meters: [{ meterId: 'weekly', label: 'Weekly', used: 50, limit: 100, utilizationPct: 50, unit: 'requests', resetsAt: 1000, windowDurationMs: 1000, status: 'ok', details: {} }] });
        const current = { ...witness, observedAtMs: 1250, fetchedAtMs: 1250, staleAfterMs: 500, meters: [{ ...witness.meters[0]!, resetsAt: 2000 }] };
        const record = (snapshot: ProviderAccountUsageSnapshotV1) => ({ content: { t: 'plain', v: snapshot }, metadata: { fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs, status: 'ok' }, sources: [source] });
        let nowMs = 1250;
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        let release!: () => void;
        const heldResponse = new Promise<void>(resolve => { release = resolve; });
        let entered!: () => void;
        const responseEntered = new Promise<void>(resolve => { entered = resolve; });
        const request = vi.fn(async (path: string) => {
            if (path.includes(held === 'pending' ? '/reset-starts/read' : '/history')) { entered(); await heldResponse; }
            const value = path.includes('/sources/resolve') ? { source, recordId: current.recordId, providerAccountId: current.recordKey.accountSubjectId, fetchedAt: 1250, staleAfterMs: 500 }
                : path.includes('/reset-starts/read') ? { entries: [{ sessionId: 'session', localId: 'held', reset: { source, recordId: witness.recordId, meterId: 'weekly', witness: { id: 'accepted', observedAtMs: 500 } }, authorityCurrent: true }] }
                : path.includes('/history') ? { entries: [{ id: 'accepted', observedAtMs: 500, record: record(witness) }], nextCursor: null } : record(current);
            return new Response(JSON.stringify(value), { status: 200 });
        });
        try {
            const { getProviderAccountUsageQuota } = await loadApi();
            const options = { accountMode: 'plain' as const, request };
            const reading = getProviderAccountUsageQuota({ token: 'plain-token' }, { source }, options);
            await responseEntered;
            nowMs = 2251;
            release();
            const result = await reading;
            expect(result.current).toEqual(current);
            expect(result.pace).toMatchObject([{ value: { status: 'unavailable', reason: 'stale' } }]);
            expect(result.waitingWork).toMatchObject({ status: 'available', entries: [{ readiness: { status: 'waiting', reason: 'quota_stale' } }] });
            const deterministic = await getProviderAccountUsageQuota({ token: 'plain-token' }, { source }, { ...options, nowMs: 1250 });
            expect(deterministic.pace).toMatchObject([{ value: { status: 'available', pace: 2 } }]);
            expect(deterministic.waitingWork).toMatchObject({ status: 'available', entries: [{ readiness: { status: 'ready' } }] });
        } finally { release(); clock.mockRestore(); }
    });
    it('does not report requested history as empty when its admitted source has an unavailable history route', async () => {
        const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const };
        const snapshot = makeSnapshot();
        let historyAvailable = false;
        const request = vi.fn(async (path: string) => path.includes('/history')
            ? new Response(JSON.stringify(historyAvailable ? { entries: [], nextCursor: null } : {}), { status: historyAvailable ? 200 : 404 })
            : new Response(JSON.stringify(path.includes('/sources/resolve') ? { source, recordId: snapshot.recordId, providerAccountId: snapshot.recordKey.accountSubjectId, fetchedAt: 1, staleAfterMs: 2 } : path.includes('/reset-starts/read') ? { entries: [] } : { content: { t: 'plain', v: snapshot }, metadata: { fetchedAt: 1, staleAfterMs: 2, status: 'ok' }, sources: [source] }), { status: 200 }));
        const { getProviderAccountUsageQuota } = await loadApi();
        await expect(getProviderAccountUsageQuota({ token: 'plain-token' }, { source, history: { range: { startAtMs: 0, endAtMs: 2 }, pageSize: 1 } }, { accountMode: 'plain', request, nowMs: 1 })).rejects.toMatchObject({ code: 'provider_account_usage_content_unavailable' });
        historyAvailable = true;
        expect((await getProviderAccountUsageQuota({ token: 'plain-token' }, { source, history: { range: { startAtMs: 0, endAtMs: 2 }, pageSize: 1 } }, { accountMode: 'plain', request, nowMs: 1 })).history).toEqual({ entries: [], nextCursor: null });
    });
    it('projects actual held work only after the canonical Pending metadata and exact immutable B witness are opened', async () => {
        const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const };
        const base = makeSnapshot();
        const witness = ProviderAccountUsageSnapshotV1Schema.parse({ ...base, observedAtMs: 500, fetchedAtMs: 500, staleAfterMs: 2000, meters: [{ meterId: 'weekly', label: 'Weekly', used: 50, limit: 100, utilizationPct: 50, unit: 'requests', resetsAt: 1000, windowDurationMs: 1000, status: 'ok', details: {} }] });
        const current = ProviderAccountUsageSnapshotV1Schema.parse({ ...witness, observedAtMs: 1250, fetchedAtMs: 1250, meters: [{ ...witness.meters[0]!, resetsAt: 2000 }] });
        const record = (snapshot: ProviderAccountUsageSnapshotV1) => ({ content: { t: 'plain', v: snapshot }, metadata: { fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs, status: 'ok' }, sources: [source] });
        const request = vi.fn(async (path: string) => {
            const value = path.includes('/sources/resolve') ? { source, recordId: current.recordId, providerAccountId: current.recordKey.accountSubjectId, fetchedAt: 1250, staleAfterMs: 2000 }
                : path.includes('/reset-starts/read') ? { entries: [{ sessionId: 'session', localId: 'held', reset: { source, recordId: witness.recordId, meterId: 'weekly', witness: { id: 'accepted', observedAtMs: 500 } }, authorityCurrent: true }] }
                : path.includes('/history') ? { entries: [{ id: 'accepted', observedAtMs: 500, record: record(witness) }], nextCursor: null } : record(current);
            return new Response(JSON.stringify(value), { status: 200 });
        });
        const { getProviderAccountUsageQuota } = await loadApi();
        expect((await getProviderAccountUsageQuota({ token: 'plain-token' }, { source }, { accountMode: 'plain', request, nowMs: 1250 })).waitingWork).toEqual({ status: 'available', entries: [{ sessionId: 'session', localId: 'held', recordId: witness.recordId, meterId: 'weekly', readiness: { status: 'ready' } }] });
    });
    it('opens qualified current and history facts through the captured request in keyless plain mode', async () => {
        const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const };
        const snapshot = makeSnapshot();
        const unboundEntries = [
            { sessionId: 'session', localId: 'queued', authorityCurrent: true },
            { sessionId: 'offline-session', localId: 'queued', authorityCurrent: false },
        ];
        const record = { content: { t: 'plain', v: snapshot }, metadata: { fetchedAt: 1, staleAfterMs: 2, status: 'ok' }, sources: [source] };
        const request = vi.fn(async (path: string) => new Response(JSON.stringify(
            path.includes('/sources/resolve') ? { source, recordId: snapshot.recordId, providerAccountId: snapshot.recordKey.accountSubjectId, fetchedAt: 1, staleAfterMs: 2 }
                : path.includes('/reset-starts/read') ? { entries: [], unboundEntries }
                : path.includes('/history') ? { entries: [{ id: 'saved-observation', observedAtMs: 1, record }], nextCursor: null }
                : record,
        ), { status: 200 }));
        const { getProviderAccountUsageQuota } = await loadApi();
        const result = await getProviderAccountUsageQuota({ token: 'plain-token' }, { source, history: { range: { startAtMs: 0, endAtMs: 2 }, pageSize: 1 } }, { accountMode: 'plain', request, nowMs: 1 });
        expect(result.current).toEqual(snapshot);
        expect(result.history?.entries[0]?.snapshot).toEqual(snapshot);
        expect(result.waitingWork).toEqual({ status: 'available', entries: [], unboundEntries });
    });
    it.each([false, true])('gets a plaintext provider account usage snapshot by record id (retained extras: %s)', async retainedExtras => {
        await activateTestHome();
        const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
        const snapshot = openSealedProviderAccountUsageSnapshot({ material, sealed: sealProviderAccountUsageSnapshot({
            material, snapshot: makeSnapshot(), randomBytes: length => new Uint8Array(length).fill(9),
        }) });
        if (!snapshot) throw new Error('Canonical usage writer did not produce readable content');
        let servedSnapshot = false;
        const fetchMock = vi.fn(async (input: unknown) => {
            if (isServerFetchConnectivityProbeRequest(input)) {
                return Response.json({ ok: true });
            }
            if (servedSnapshot) return new Response(null, { status: 404 });
            servedSnapshot = true;
            return Response.json({
                    content: { t: 'plain', v: retainedExtras ? { ...snapshot, retired: true,
                        recordKey: { ...snapshot.recordKey, retired: true },
                        accountSubject: { ...snapshot.accountSubject, retired: true } } : snapshot },
                    metadata: { fetchedAt: 1, staleAfterMs: 2, status: 'ok' },
                    sources: [],
            });
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { getProviderAccountUsageSnapshotPlain } = await loadApi();
        const result = await getProviderAccountUsageSnapshotPlain(credentials, { recordId: snapshot.recordId });

        expect(result).toEqual(snapshot);
        expect(fetchMock).toHaveBeenCalledWith(
            `https://api.example.test/v4/connect/qualified/provider-account-usage/record?recordId=${encodeURIComponent(snapshot.recordId)}`,
            expect.objectContaining({ method: 'GET', headers: expect.any(Headers) }),
        );
    });

    it.each(['mode', 'identity', 'metadata', 'malformed'] as const)('refuses a saved plain snapshot with %s mismatch', async mismatch => {
        await activateTestHome();
        const snapshot = makeSnapshot();
        const fetchMock = vi.fn(async (input: unknown) => {
            if (isServerFetchConnectivityProbeRequest(input)) return Response.json({ ok: true });
            return Response.json({
                content: mismatch === 'mode' ? { t: 'encrypted', c: 'opaque' } : { t: 'plain', v: {
                    ...snapshot,
                    ...(mismatch === 'identity' ? { recordKey: { ...snapshot.recordKey, accountSubjectId: 'foreign' } } : {}),
                    ...(mismatch === 'malformed' ? { fetchedAtMs: 'invalid' } : {}),
                } },
                metadata: { fetchedAt: mismatch === 'metadata' ? 2 : 1, staleAfterMs: 2, status: 'ok' },
                sources: [],
            });
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
        const { getProviderAccountUsageSnapshotPlain } = await loadApi();
        await expect(getProviderAccountUsageSnapshotPlain(credentials, { recordId: snapshot.recordId })).rejects.toMatchObject({
            code: mismatch === 'mode' ? 'provider_account_usage_content_mode_mismatch'
                : mismatch === 'metadata' ? 'provider_account_usage_identity_mismatch' : 'provider_account_usage_content_unavailable',
        });
    });

    it('gets a sealed provider account usage snapshot by record id', async () => {
        await activateTestHome();
        const snapshot = makeSnapshot();
        const fetchMock = vi.fn(async (input: unknown) => {
            if (isServerFetchConnectivityProbeRequest(input)) {
                return Response.json({ ok: true });
            }
            return Response.json({
                    content: { t: 'encrypted', c: 'ciphertext', recoveryCreditDetails: { ciphertext: 'details-ciphertext' } },
                    metadata: { fetchedAt: 1, staleAfterMs: 2, status: 'ok' },
                    sources: [],
            });
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { getProviderAccountUsageSnapshotSealed } = await loadApi();
        const result = await getProviderAccountUsageSnapshotSealed(credentials, { recordId: snapshot.recordId });

        expect(result?.content).toEqual({ t: 'encrypted', c: 'ciphertext', recoveryCreditDetails: { ciphertext: 'details-ciphertext' } });
        expect(fetchMock).toHaveBeenCalledWith(
            `https://api.example.test/v4/connect/qualified/provider-account-usage/record?recordId=${encodeURIComponent(snapshot.recordId)}`,
            expect.objectContaining({ method: 'GET', headers: expect.any(Headers) }),
        );
    });

    it('normalizes canonical storage-mode conflicts for plain and sealed reads', async () => {
        await activateTestHome();
        const snapshot = makeSnapshot();
        const fetchMock = vi.fn(async (input: unknown) => {
            if (isServerFetchConnectivityProbeRequest(input)) {
                return Response.json({ ok: true });
            }
            return Response.json({
                    error: 'provider_account_usage_storage_mode_mismatch',
            }, { status: 409 });
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const {
            getProviderAccountUsageSnapshotPlain,
            getProviderAccountUsageSnapshotSealed,
        } = await loadApi();
        const expected = {
            code: 'provider_account_usage_content_mode_mismatch',
            status: 409,
            kind: 'server',
            canTryAgain: false,
        };

        await expect(getProviderAccountUsageSnapshotPlain(
            credentials,
            { recordId: snapshot.recordId },
        )).rejects.toMatchObject(expected);
        await expect(getProviderAccountUsageSnapshotSealed(
            credentials,
            { recordId: snapshot.recordId },
        )).rejects.toMatchObject(expected);
    });

    it('requests a provider account usage refresh through the V4 record owner', async () => {
        await activateTestHome();
        const snapshot = makeSnapshot();
        const fetchMock = vi.fn(async (input: unknown) => {
            if (isServerFetchConnectivityProbeRequest(input)) {
                return Response.json({ ok: true });
            }
            return Response.json({ success: true });
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { requestProviderAccountUsageSnapshotRefresh } = await loadApi();
        await expect(requestProviderAccountUsageSnapshotRefresh(
            credentials,
            { recordId: snapshot.recordId },
        )).resolves.toBe(true);

        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.example.test/v4/connect/qualified/provider-account-usage/record/refresh',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ recordId: snapshot.recordId }),
                headers: expect.any(Headers),
            }),
        );
    });
});
