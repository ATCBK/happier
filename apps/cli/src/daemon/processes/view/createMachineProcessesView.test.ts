import { afterEach, expect, it, vi } from 'vitest';
import type { ProcessCensusInput, ProcessCensusSnapshot } from '@/processes/census/processCensus';
import { createProcessOwnershipRuntime } from '../ownership/processOwnershipRuntime';
import { createLeftBehindPass } from '../leftBehind/leftBehindPass';
import { createMachineVitalsSampler } from '@/daemon/vitals/createMachineVitalsSampler';
import { createMachineProcessesView } from './createMachineProcessesView';
import { createMinuteHistoryStore } from '@/daemon/vitals/history/minuteHistoryStore';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalServiceInventoryRegistry } from '@/daemon/local/services/inventory/registry';
import { createLocalServiceInventoryRoutes } from '@/daemon/local/services/inventory/routes';
import { MACHINE_WATCH_WINDOW_MS } from '@happier-dev/protocol/rpc/machineWatchWindow';

// Native census and vitals I/O are system boundaries; the sampler and every domain owner are real.
const boundary = vi.hoisted(() => ({ read: vi.fn<(input: ProcessCensusInput) => Promise<ProcessCensusSnapshot>>() }));
vi.mock('@/processes/census/processCensus', () => ({ readProcessCensus: boundary.read }));
afterEach(() => { vi.useRealTimers(); boundary.read.mockReset(); });
it('samples only while watched, retaining CPU/history across re-arm until the shared watch window expires', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    let name = 'daemon';
    boundary.read.mockImplementation(async () => ({ status: 'ok', capturedAtMs: Date.now(), logicalCpus: 2, rows: [
        { pid: 100, ppid: 1, start: { startTimeMs: 100 }, principal: { kind: 'uid', value: '1000' }, name, memory: { bytes: 20, kind: 'rss' }, cpuTimeUs: Date.now() * 100 },
    ] }));
    const runtime = createProcessOwnershipRuntime({ selfPid: 100, platform: 'darwin', daemonScopeKey: '123456789abc', listRoots: () => [
        { owner: { kind: 'happier' }, pid: 100, start: { startTimeMs: 100 }, ownerCreatedAtMs: 100, live: true },
    ] });
    const pass = createLeftBehindPass({ processOwnershipRuntime: runtime });
    const directory = await mkdtemp(join(tmpdir(), 'processes-watch-'));
    const sampler = createMachineVitalsSampler({ readers: { read: async input => ({ state: 'reporting',
        host: { logicalCores: 2, memoryTotalBytes: 1000, bootedAt: 0 },
        sample: { v: 1, sampledAt: input.sampledAt, intervalMs: input.intervalMs, cpu: { reported: true, busyPct: null },
            memory: { reported: true, totalBytes: 1000, availableBytes: 900, usedBytes: 100, pressure: { level: 'calm', source: 'events' } },
            disk: { reported: false, reason: 'unavailable' }, network: { reported: false, reason: 'unavailable' } },
        minuteCounters: { monotonicMs: input.monotonicMs, cpu: null, network: null },
    }) }, historyStore: await createMinuteHistoryStore({ directory }), monotonicMs: () => Date.now() });
    await sampler.start();
    const registry = createLocalServiceInventoryRegistry();
    registry.replaceSnapshot({ v: 1, machineId: 'm', generatedAt: 1000, refreshState: 'idle', diagnostics: [], entries: [{
        id: 'listener', machineId: 'm', address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' }, port: 5173, protocol: 'tcp',
        detectedAt: 1000, lastSeenAt: 1000, state: 'listening', source: 'detected', labels: [], confidence: 'high',
        processOwnershipConfidence: 'high', workspaceAssociationConfidence: 'high', diagnostics: [],
        provenance: { process: { pid: 100, processStartTimeMs: 100, lineagePids: [100], command: 'daemon', redacted: true } },
    }] });
    const localServiceRoutes = createLocalServiceInventoryRoutes({ registry });
    const view = createMachineProcessesView({ processOwnershipRuntime: runtime, leftBehind: pass, machineVitals: sampler, localServiceRoutes,
        platform: 'darwin', selfPid: 100, allProcessesVisible: () => false, requesterForOwner: () => ({ accountId: 'a', displayName: 'A' }) });
    const requester = { accountId: 'a', custodianAccountId: 'a' };
    const initial = await view.list({ machineId: 'm' }, requester);
    const standalone = await view.get({ machineId: 'm', ref: initial.owners[0].members[0].ref }, requester);
    expect(standalone.row).toMatchObject({ ports: [{ port: 5173, inventoryEntryId: 'listener' }] });
    expect(localServiceRoutes.watcherCount()).toBe(0);
    name = 'fresh native name';
    const firstWatch = await view.watch({ machineId: 'm', scope: 'happier', view: 'tree' }, requester);
    expect(firstWatch.changed && firstWatch.answer.owners[0].members[0].name).toBe(name);
    const fullCensusCount = () => boundary.read.mock.calls.filter(([input]) => input.pids === undefined).length;
    const fullCensusesBeforeIdleIntervals = fullCensusCount();
    const controller = new AbortController();
    const watched = view.watch({ machineId: 'm', scope: 'happier', view: 'tree', since: initial.capturedAtMs }, requester, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(localServiceRoutes.watcherCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    const answer = await watched;
    expect(answer.changed).toBe(true);
    expect(localServiceRoutes.watcherCount()).toBe(0);
    const ref = initial.owners[0].members[0].ref;
    const rearmed = view.watch({ machineId: 'm', scope: 'happier', view: 'tree', since: Date.now(), detailToken: ref }, requester);
    await vi.advanceTimersByTimeAsync(2000);
    const second = await rearmed;
    expect(second.changed && second.answer.owners[0].members[0].cpuPercent).toBe(5);
    expect(second.changed && second.answer.history?.[ref]).toHaveLength(2);
    const thirdWatch = view.watch({ machineId: 'm', scope: 'happier', view: 'tree', since: second.changed ? second.answer.capturedAtMs : 0 }, requester);
    await vi.advanceTimersByTimeAsync(2000);
    const third = await thirdWatch;
    expect(third.changed).toBe(true);
    expect(fullCensusCount()).toBe(fullCensusesBeforeIdleIntervals);
    expect(boundary.read.mock.calls.some(([input]) => input.pids !== undefined
        && input.fields?.includes('memory') && input.fields.includes('cpuTimeUs'))).toBe(true);
    const reads = boundary.read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4000);
    expect(boundary.read.mock.calls.length).toBe(reads);
    expect((await view.get({ machineId: 'm', ref }, requester)).history).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(MACHINE_WATCH_WINDOW_MS);
    expect((await view.get({ machineId: 'm', ref }, requester)).history).toBeUndefined();
    const cancellation = new AbortController();
    const parked = view.watch({ machineId: 'm', scope: 'happier', view: 'tree', since: Date.now() }, requester, cancellation.signal);
    await vi.advanceTimersByTimeAsync(0);
    cancellation.abort();
    expect(await parked).toEqual({ changed: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(localServiceRoutes.watcherCount()).toBe(0);
    view.dispose(); pass.dispose(); await sampler.stop(); await rm(directory, { recursive: true, force: true });
});
