import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit';
import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import type { MachineVitalsHistoryV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsHistoryV1';
import type { MachineVitalsSnapshotV1, MachineVitalsWatchResultV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsRpcV1';
import { MachineResourceSummaryV1Schema, projectMachineResourceSummaryV1 } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import type { MachineResourceRpcResult, MachineVitalsWatchInput, MachineVitalsHistoryReadInput } from './machineRpc';
import { createMachineResourceStore, isMachineResourceStateStale } from './machineResourceStore';

const sample = (sampledAt: number): MachineVitalsSampleV1 => ({
    v: 1, sampledAt, intervalMs: 15_000,
    cpu: { reported: true, busyPct: 20 },
    memory: { reported: true, totalBytes: 100, availableBytes: 80, usedBytes: 20, pressure: { level: 'calm', source: 'psi' } },
    disk: { reported: true, volumes: [] }, network: { reported: true, rxBps: 12, txBps: 3 },
});
const snapshot = (sampledAt = 60_000): MachineVitalsSnapshotV1 => ({
    state: 'reporting', sample: sample(sampledAt),
    series5m: { cpu: [{ t: sampledAt, y: 20 }], memory: [{ t: sampledAt, y: 80 }], networkRx: [{ t: sampledAt, y: 12 }], networkTx: [{ t: sampledAt, y: 3 }] },
});
const key = { serverId: 'home-a', machineId: 'machine-a', view: 'summary' as const };
type WatchAnswer = MachineResourceRpcResult<MachineVitalsWatchResultV1>;

function harness(nowMs: () => number = () => 60_000) {
    const watches: Array<{ input: MachineVitalsWatchInput; answer: ReturnType<typeof createDeferred<WatchAnswer>> }> = [];
    const snapshotClient = vi.fn(async (): Promise<MachineResourceRpcResult<MachineVitalsSnapshotV1>> => ({ ok: true, value: snapshot() }));
    const watchClient = vi.fn((input: MachineVitalsWatchInput) => {
        const answer = createDeferred<WatchAnswer>();
        watches.push({ input, answer });
        input.signal?.addEventListener('abort', () => answer.resolve({ ok: false, reason: 'request_failed' }), { once: true });
        return answer.promise;
    });
    const historyClient = vi.fn(async (_input: MachineVitalsHistoryReadInput): Promise<MachineResourceRpcResult<MachineVitalsHistoryV1>> => ({ ok: false, reason: 'request_failed' }));
    return { store: createMachineResourceStore({ snapshotClient, watchClient, historyClient }, nowMs), watches, snapshotClient, watchClient, historyClient };
}

async function settle() { for (let turn = 0; turn < 8; turn++) await Promise.resolve(); }

describe('machine resources subscription owner', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('keeps held samples, history and unavailable-method facts within their exact Home Account', async () => {
        const h = harness();
        const accountA = { ...key, expectedAccountId: 'account-a' };
        const accountB = { ...key, expectedAccountId: 'account-b' };
        await h.store.read(accountA);
        expect(h.store.getState(accountB).snapshot).toBeNull();
        expect(h.store.getState({ ...accountB, view: 'overview' }).snapshot).toBeNull();
        h.historyClient.mockResolvedValueOnce({ ok: true, value: { range: '1h', bucketMs: 60_000, points: [], today: { rxBytes: 1, txBytes: 2 } } });
        await h.store.readHistory({ ...accountA, range: '1h' });
        expect(h.store.getHistory({ ...accountB, range: '1h' }).history).toBeNull();
        h.snapshotClient.mockResolvedValueOnce({ ok: false, reason: 'older_happier' });
        await h.store.read(accountA);
        expect(h.store.getState(accountA).status).toBe('not_reported');
        expect(h.store.getState(accountB).status).toBe('loading');
        await h.store.read(accountB);
        expect(h.store.getState(accountB).status).toBe('ready');
        h.store.reset();
    });

    it('holds the last measured CPU across unreported samples without filling history gaps or another machine', async () => {
        const h = harness();
        const missing = snapshot(75_000);
        missing.sample!.cpu = { reported: false, reason: 'unavailable' };
        missing.series5m.cpu = [{ t: 75_000, y: null }];
        await h.store.read(key);
        h.snapshotClient.mockResolvedValueOnce({ ok: true, value: missing });
        await h.store.read(key);
        expect(h.store.getState(key).summary?.cpu.busyPct).toBe(20);
        expect(h.store.getState(key).snapshot?.sample?.cpu.reported).toBe(false);
        expect(h.store.getState(key).summary?.cpu.series.at(-1)?.y).toBeNull();
        h.snapshotClient.mockResolvedValueOnce({ ok: true, value: missing });
        await h.store.read({ ...key, machineId: 'never-measured' });
        expect(h.store.getState({ ...key, machineId: 'never-measured' }).summary?.cpu.busyPct).toBeNull();
        const recovered = snapshot(90_000);
        recovered.sample!.cpu = { reported: true, busyPct: 0 };
        h.snapshotClient.mockResolvedValueOnce({ ok: true, value: recovered });
        await h.store.read(key);
        expect(h.store.getState(key).summary?.cpu.busyPct).toBe(0);
        h.store.reset();
    });

    it('retains the typed read refusal for diagnosis and clears it after recovery', async () => {
        const h = harness();
        h.snapshotClient.mockResolvedValueOnce({ ok: false, reason: 'request_failed', errorCode: 'action_disabled' });
        await h.store.read(key);
        expect(h.store.getState(key)).toMatchObject({ status: 'error', errorCode: 'action_disabled' });
        await h.store.retry(key);
        expect(h.store.getState(key).status).toBe('ready');
        expect(h.store.getState(key)).not.toHaveProperty('errorCode');
        h.store.reset();
    });

    it('retries retained summary and history failures after reachability removed live demand', async () => {
        const h = harness();
        const historyKey = { ...key, range: '1h' as const };
        const history = { range: '1h' as const, bucketMs: 60_000, points: [], today: { rxBytes: 0, txBytes: 0 } };
        h.snapshotClient.mockResolvedValueOnce({ ok: false, reason: 'request_failed' });
        await h.store.read(key);
        await h.store.readHistory(historyKey);
        expect(h.store.getState(key).status).toBe('error');
        expect(h.store.getHistory(historyKey).status).toBe('error');
        h.historyClient.mockResolvedValueOnce({ ok: true, value: history });
        await h.store.retry(key);
        await h.store.retryHistory(historyKey);
        expect(h.store.getState(key).status).toBe('ready');
        expect(h.store.getState(key).snapshot).toEqual(snapshot());
        expect(h.store.getHistory(historyKey)).toEqual({ status: 'ready', history });
        expect(h.watchClient).not.toHaveBeenCalled();
        h.store.reset();
    });

    it('warms once per app session with one shared read and no live demand', async () => {
        const h = harness();
        await Promise.all([h.store.warm(key), h.store.warm(key)]);
        await h.store.warm(key);
        expect(h.snapshotClient).toHaveBeenCalledOnce();
        expect(h.watchClient).not.toHaveBeenCalled();
        expect(h.store.getState(key).snapshot).toEqual(snapshot());
        expect(h.store.getState(key).summary?.memory.availableBytes).toBe(80);
        expect(h.store.getState(key).summary?.memory.series).toBe(h.store.getState(key).snapshot?.series5m.memory);
        const warmed = h.store.getState(key);
        h.snapshotClient.mockResolvedValueOnce({ ok: true, value: structuredClone(snapshot()) });
        await h.store.read(key);
        expect(h.store.getState(key).summary).toBe(warmed.summary);
        expect(h.store.getState(key).snapshot?.series5m).toBe(warmed.snapshot?.series5m);
        h.store.reset();
    });

    it('lets an unopened offline Overview read the sample already held by its summary without another RPC', async () => {
        const h = harness();
        const overview = { ...key, view: 'overview' as const };
        const otherHome = { ...overview, serverId: 'home-b' };
        const updates = vi.fn();
        const release = h.store.observe(overview, updates);
        expect(h.store.getState(overview).snapshot).toBeNull();
        await h.store.warm(key);
        expect(h.store.getState(overview).snapshot?.sample).toEqual(sample(60_000));
        expect(h.store.getState(otherHome).snapshot).toBeNull();
        expect(updates).toHaveBeenCalled();
        expect(h.snapshotClient).toHaveBeenCalledOnce();
        expect(h.watchClient).not.toHaveBeenCalled();
        h.snapshotClient.mockResolvedValueOnce({ ok: false, reason: 'request_failed' });
        await h.store.read(overview);
        expect(h.store.getState(overview).snapshot?.sample).toEqual(sample(60_000));
        expect(h.store.getState(overview).status).toBe('error');
        release();
        h.store.reset();
    });

    it('projects only authoritative attention tones and selects its disk volume without a guessed default', () => {
        const source = snapshot();
        source.sample!.cpu = { reported: true, busyPct: 99 };
        source.sample!.memory = { reported: true, totalBytes: 100, availableBytes: 80, usedBytes: 20, pressure: { level: 'critical', source: 'psi' } };
        source.sample!.disk = { reported: true, volumes: [
            { id: 'root', label: 'Root', mount: '/', totalBytes: 100, availableBytes: 50 },
            { id: 'data', label: 'Data', mount: '/data', totalBytes: 100, availableBytes: 0 },
        ] };
        const calm = projectMachineResourceSummaryV1(source)!;
        expect(calm.cpu.tone).toBe('calm');
        expect(calm.memory.tone).toBe('calm');
        expect(calm.disk.availableBytes).toBeNull();
        source.sample!.disk.homeVolumeId = 'root';
        expect(projectMachineResourceSummaryV1(source)?.disk.availableBytes).toBe(50);
        source.attention = { level: 'needs_you', reasons: [{
            key: 'disk:data', kind: 'disk_full', metric: 'disk', level: 'needs_you', since: 60_000, volumeId: 'data', volumeLabel: 'Data',
        }] };
        const summary = projectMachineResourceSummaryV1(source)!;
        expect(summary.disk.volumeId).toBe('data');
        expect(summary.disk.availableBytes).toBe(0);
        expect(summary.disk.tone).toBe('crit');
        expect(summary.memory.availableBytes).toBe(80);
        expect(summary.seriesFrom).toBe(60_000);
        expect(MachineResourceSummaryV1Schema.safeParse(summary).success).toBe(true);
    });

    it('shares one read and one watch per Home, machine and view, re-arms and preserves unchanged parts', async () => {
        const h = harness();
        const releaseA = h.store.demand(key);
        const releaseB = h.store.demand(key);
        await settle();
        expect(h.snapshotClient).toHaveBeenCalledOnce();
        expect(h.watches).toHaveLength(1);
        expect(h.watches[0].input.sinceSampledAt).toBe(60_000);
        const before = h.store.getState(key);
        h.watches[0].answer.resolve({ ok: true, value: { changed: true, samples: [sample(75_000)] } });
        await settle();
        const after = h.store.getState(key);
        expect(after.snapshot?.sample?.sampledAt).toBe(75_000);
        expect(after.snapshot?.sample?.memory).toBe(before.snapshot?.sample?.memory);
        expect(after.snapshot?.series5m.cpu[0]).toBe(before.snapshot?.series5m.cpu[0]);
        expect(after.summary?.memory.availableBytes).toBe(80);
        expect(after.summary?.memory.series.at(-1)?.y).toBe(80);
        expect(h.watches).toHaveLength(2);
        h.watches[1].answer.resolve({ ok: true, value: { changed: true, samples: [structuredClone(sample(75_000))] } });
        await settle();
        expect(h.store.getState(key)).toBe(after);
        releaseA();
        expect(h.watches.at(-1)?.input.signal?.aborted).toBe(false);
        releaseB();
        expect(h.watches.at(-1)?.input.signal?.aborted).toBe(true);
        expect(h.store.getState(key)).toBe(after);
        h.store.reset();
    });

    it('keeps unrelated machines and views moving while a read is slow', async () => {
        const h = harness();
        const slow = createDeferred<MachineResourceRpcResult<MachineVitalsSnapshotV1>>();
        h.snapshotClient.mockImplementationOnce(() => slow.promise);
        const slowRead = h.store.read(key);
        const otherRead = h.store.read({ ...key, machineId: 'machine-b' });
        await otherRead;
        expect(h.store.getState({ ...key, machineId: 'machine-b' }).status).toBe('ready');
        slow.resolve({ ok: true, value: snapshot() });
        await slowRead;
        await h.store.read({ ...key, serverId: 'home-b' });
        await h.store.read({ ...key, view: 'overview' });
        expect(h.snapshotClient).toHaveBeenCalledTimes(4);
        h.store.reset();
    });

    it('does not replace a newer parked-watch sample with an older in-flight refresh', async () => {
        const h = harness();
        const release = h.store.demand(key);
        await settle();
        const slow = createDeferred<MachineResourceRpcResult<MachineVitalsSnapshotV1>>();
        h.snapshotClient.mockImplementationOnce(() => slow.promise);
        const refresh = h.store.read(key);
        h.watches[0].answer.resolve({ ok: true, value: { changed: true, samples: [sample(90_000)] } });
        await settle();
        const watched = h.store.getState(key);
        slow.resolve({ ok: true, value: snapshot(75_000) });
        await refresh;
        expect(h.store.getState(key)).toBe(watched);
        expect(h.store.getState(key).summary?.sampledAt).toBe(90_000);
        release(); h.store.reset();
    });

    it('appends raw one-hour live data and refreshes only demanded daemon history at the minute frontier', async () => {
        const h = harness();
        let rxBytes = 0;
        h.historyClient.mockImplementation(async input => ({ ok: true, value: {
            range: input.range, bucketMs: 60_000, points: [], today: { rxBytes, txBytes: 0 },
        } }));
        const overviewKey = { ...key, view: 'overview' as const };
        const historyKey = { ...key, range: '24h' as const };
        const releaseHistory = h.store.demandHistory(historyKey);
        const release = h.store.demand(overviewKey);
        await settle();
        h.watches[0].answer.resolve({ ok: true, value: { changed: true, samples: [sample(75_000)] } });
        await settle();
        expect(h.historyClient).toHaveBeenCalledOnce();
        rxBytes = 50;
        h.watches[1].answer.resolve({ ok: true, value: { changed: true, samples: [sample(120_000)] } });
        await settle();
        expect(h.store.getHistory(historyKey).history?.today.rxBytes).toBe(50);
        expect(h.store.getState(overviewKey).samples.map(point => point.sampledAt)).toEqual([60_000, 75_000, 120_000]);
        expect(h.historyClient).toHaveBeenCalledTimes(2);
        releaseHistory();
        h.watches[2].answer.resolve({ ok: true, value: { changed: true, samples: [sample(180_000)] } });
        await settle();
        expect(h.historyClient).toHaveBeenCalledTimes(2);
        release(); h.store.reset();
    });

    it('remembers method-not-found across views and retry until daemon state changes', async () => {
        const h = harness();
        h.snapshotClient.mockResolvedValueOnce({ ok: false, reason: 'older_happier' });
        await h.store.read(key);
        expect(h.store.getState(key).status).toBe('not_reported');
        const release = h.store.demand({ ...key, view: 'overview' });
        h.store.retry(key);
        await settle();
        expect(h.snapshotClient).toHaveBeenCalledOnce();
        expect(h.watchClient).not.toHaveBeenCalled();
        h.store.daemonStateChanged(key, 2);
        await settle();
        expect(h.store.getState({ ...key, view: 'overview' }).status).toBe('ready');
        release(); h.store.reset();
    });

    it('allows a one-shot warm to discover an upgraded daemon after a remembered unsupported answer', async () => {
        const h = harness();
        h.snapshotClient.mockResolvedValueOnce({ ok: false, reason: 'older_happier' });
        await h.store.warm({ ...key, daemonStateVersion: 1 });
        await h.store.warm({ ...key, daemonStateVersion: 1 });
        expect(h.snapshotClient).toHaveBeenCalledOnce();
        h.store.daemonStateChanged(key, 2);
        await h.store.warm({ ...key, daemonStateVersion: 2 });
        expect(h.store.getState(key).summary?.memory.availableBytes).toBe(80);
        expect(h.snapshotClient).toHaveBeenCalledTimes(2);
        expect(h.watchClient).not.toHaveBeenCalled();
        h.store.reset();
    });

    it('derives stale state at two missed sample intervals without a freshness timer', async () => {
        vi.useFakeTimers();
        const h = harness();
        await h.store.read(key);
        const state = h.store.getState(key);
        expect(isMachineResourceStateStale(state, 89_999)).toBe(false);
        expect(isMachineResourceStateStale(state, 90_000)).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        h.store.reset();
    });

    it.each(['summary', 'overview'] as const)('fresh %s answers update a retained sibling view without replacing its details', async (view) => {
        let now = 60_000;
        const h = harness(() => now);
        const source = { ...key, view };
        const sibling = { ...key, view: view === 'summary' ? 'overview' as const : 'summary' as const };
        const held = { ...snapshot(), sample: { ...sample(60_000), thermal: { state: 'nominal' as const } } };
        h.snapshotClient.mockResolvedValueOnce({ ok: true, value: held });
        await h.store.read(sibling);
        h.snapshotClient.mockResolvedValueOnce({ ok: true, value: {
            ...held, sample: { ...held.sample, thermal: { state: 'fair' as const } },
        } });
        const release = h.store.demand(source);
        await settle();
        now = 120_000;
        expect(isMachineResourceStateStale(h.store.getState(sibling), now)).toBe(true);
        h.watches[0]!.answer.resolve({ ok: true, value: { changed: true, samples: [sample(now)] } });
        await settle();
        const fresh = h.store.getState(sibling);
        expect(fresh.snapshot?.sample?.sampledAt).toBe(now);
        expect(fresh.snapshot?.sample?.thermal).toEqual(held.sample.thermal);
        expect(h.store.getState(source).snapshot?.sample?.thermal).toBeUndefined();
        expect(fresh.status).toBe('ready');
        expect(isMachineResourceStateStale(fresh, now)).toBe(false);
        expect(h.store.getState(sibling)).toBe(fresh);
        const otherHome = { ...sibling, serverId: 'home-b' };
        expect(h.store.getState(otherHome).snapshot).toBeNull();
        now = 135_000;
        h.snapshotClient.mockResolvedValueOnce({ ok: true, value: snapshot(now) });
        await h.store.read(source);
        expect(h.store.getState(sibling).snapshot?.sample?.sampledAt).toBe(now);
        expect(h.store.getState(sibling).snapshot?.sample?.thermal).toEqual(held.sample.thermal);
        release(); h.store.reset();
    });

    it('re-arms a retired watch when a reporting daemon republishes after restarting', async () => {
        const h = harness();
        h.store.daemonStateChanged(key, 1);
        const release = h.store.demand(key);
        await settle();
        h.watches[0]!.answer.resolve({ ok: false, reason: 'request_failed' });
        await settle();
        expect(h.store.getState(key).status).toBe('error');
        h.snapshotClient.mockResolvedValueOnce({ ok: true, value: snapshot(90_000) });
        h.store.daemonStateChanged(key, 2);
        await settle();
        expect(h.store.getState(key).status).toBe('ready');
        expect(h.store.getState(key).snapshot?.sample?.sampledAt).toBe(90_000);
        expect(h.watches).toHaveLength(2);
        h.store.daemonStateChanged(key, 2);
        await settle();
        expect(h.snapshotClient).toHaveBeenCalledTimes(2);
        release(); h.store.reset();
    });

    it('recovers a failed sibling from an authorized answer at the same sample frontier without duplicating chart points', async () => {
        const h = harness();
        const overview = { ...key, view: 'overview' as const };
        await h.store.read(overview);
        h.snapshotClient.mockResolvedValueOnce({ ok: false, reason: 'request_failed' });
        await h.store.read(overview);
        expect(h.store.getState(overview).status).toBe('error');
        await h.store.read(key);
        expect(h.store.getState(overview)).toMatchObject({ status: 'ready', stale: false });
        expect(h.store.getState(overview).snapshot?.series5m.cpu).toEqual([{ t: 60_000, y: 20 }]);
        h.snapshotClient.mockResolvedValueOnce({ ok: false, reason: 'request_failed' });
        await h.store.read(overview);
        h.snapshotClient.mockResolvedValueOnce({ ok: true, value: snapshot(59_000) });
        await h.store.read(key);
        expect(h.store.getState(overview).status).toBe('error');
        h.store.reset();
    });

    it('publishes an idle-watch stale transition once without changing cached metric data or starting a timer', async () => {
        vi.useFakeTimers();
        let now = 60_000;
        const h = harness(() => now);
        const rendered: boolean[] = [];
        let previous = h.store.getState(key);
        const release = h.store.demand(key, () => {
            const current = h.store.getState(key);
            if (current === previous) return;
            previous = current;
            rendered.push(isMachineResourceStateStale(current, now));
        });
        await settle();
        const good = h.store.getState(key);
        now = 90_000;
        h.watches[0].answer.resolve({ ok: true, value: { changed: false } });
        await settle();
        expect(rendered.at(-1)).toBe(true);
        const stale = h.store.getState(key);
        expect(stale.snapshot).toBe(good.snapshot);
        expect(stale.summary).toBe(good.summary);
        expect(stale.samples).toBe(good.samples);
        const notifications = rendered.length;
        now = 120_000;
        h.watches[1].answer.resolve({ ok: true, value: { changed: false } });
        await settle();
        expect(rendered).toHaveLength(notifications);
        expect(h.snapshotClient).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
        release(); h.store.reset();
    });

    it('keeps the last good report when the reader has no replacement sample', async () => {
        const h = harness();
        await h.store.read(key);
        const good = h.store.getState(key);
        h.snapshotClient.mockResolvedValueOnce({ ok: true, value: {
            state: 'unavailable', reason: 'reader_failed', sample: null,
            series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] },
        } });
        await h.store.read(key);
        const unavailable = h.store.getState(key);
        expect(unavailable.snapshot?.state).toBe('unavailable');
        expect(unavailable.snapshot?.sample).toBe(good.snapshot?.sample);
        expect(unavailable.summary).toBe(good.summary);
        expect(unavailable.snapshot?.series5m).toBe(good.snapshot?.series5m);
        h.store.reset();
    });

    it('releases every watch and listener across twenty open-close cycles then resumes with one immediate read', async () => {
        const h = harness();
        const listener = vi.fn();
        for (let cycle = 0; cycle < 20; cycle++) {
            const release = h.store.demand(key, listener);
            await settle();
            release();
            await settle();
            expect(h.watches.every(watch => watch.input.signal?.aborted)).toBe(true);
            listener.mockClear();
            await settle();
            expect(listener).not.toHaveBeenCalled();
            expect(h.snapshotClient).toHaveBeenCalledTimes(cycle + 1);
        }
        const release = h.store.demand(key, listener);
        await settle();
        expect(h.snapshotClient).toHaveBeenCalledTimes(21);
        expect(h.watches).toHaveLength(21);
        release(); h.store.reset();
    });
});
