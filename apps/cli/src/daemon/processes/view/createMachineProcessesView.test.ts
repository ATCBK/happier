import { afterEach, expect, it, vi } from 'vitest';
import type { ProcessCensusInput, ProcessCensusSnapshot } from '@/processes/census/processCensus';
import { createProcessOwnershipRuntime } from '../ownership/processOwnershipRuntime';
import { createLeftBehindPass } from '../leftBehind/leftBehindPass';
import { createMachineVitalsSampler } from '@/daemon/vitals/createMachineVitalsSampler';
import { createMachineProcessesView } from './createMachineProcessesView';
import { createMinuteHistoryStore } from '@/daemon/vitals/history/minuteHistoryStore';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createLocalServiceInventoryRegistry } from '@/daemon/local/services/inventory/registry';
import { createLocalServiceInventoryRoutes } from '@/daemon/local/services/inventory/routes';
import { MACHINE_WATCH_WINDOW_MS } from '@happier-dev/protocol/rpc/machineWatchWindow';
import { MachineProcessesWatchResultV1Schema, type MachineProcessesWatchResultV1 } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import { spawnSupervisedPluginProcess } from '@/plugins/runtime/exec/processSupervisor';
import { once } from 'node:events';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { writeDaemonState, clearDaemonStateForTestTeardown } from '@/persistence';
import { configuration } from '@/configuration';

// Native census and vitals I/O are system boundaries; the sampler and every domain owner are real.
const boundary = vi.hoisted(() => ({ read: vi.fn<(input: ProcessCensusInput) => Promise<ProcessCensusSnapshot>>() }));
vi.mock('@/processes/census/processCensus', () => ({ readProcessCensus: boundary.read }));
afterEach(() => { vi.useRealTimers(); boundary.read.mockReset(); });
it('discovers a real Happier launch in a parked watch before either sampling cadence and stops discovery when disposed', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    let childPid: number | undefined;
    boundary.read.mockImplementation(async () => ({ status: 'ok', capturedAtMs: Date.now(), logicalCpus: 2, rows: [
        { pid: 100, ppid: 1, start: { startTimeMs: 100 }, principal: { kind: 'uid', value: '1000' }, name: 'daemon',
            memory: { bytes: 20, kind: 'rss' }, cpuTimeUs: 0 },
        ...(childPid === undefined ? [] : [{ pid: childPid, ppid: 100, start: { startTimeMs: 1000 },
            principal: { kind: 'uid' as const, value: '1000' }, name: 'tool', memory: { bytes: 30, kind: 'rss' as const }, cpuTimeUs: 0 }]),
    ] }));
    const runtime = createProcessOwnershipRuntime({ selfPid: 100, platform: 'darwin', daemonScopeKey: '123456789abc', listRoots: () => [
        { owner: { kind: 'happier' }, pid: 100, start: { startTimeMs: 100 }, ownerCreatedAtMs: 100, live: true },
    ] });
    const pass = createLeftBehindPass({ processOwnershipRuntime: runtime });
    const sampler = createMachineVitalsSampler({ readers: { read: async () => { throw new Error('No sampler tick expected'); } },
        historyStore: { read: async () => [], append: async () => true, prune: async () => undefined,
            appendAlert: async () => undefined, minutes: () => [], alerts: () => [] } });
    const view = createMachineProcessesView({ processOwnershipRuntime: runtime, leftBehind: pass, machineVitals: sampler,
        platform: 'darwin', selfPid: 100, allProcessesVisible: () => false, requesterForOwner: () => ({ accountId: 'a' }) });
    const app = createDaemonControlApp({ getChildren: () => [], machineId: 'm',
        stopSession: async () => ({ status: 'not_found' }), spawnSession: async () => ({ type: 'success', sessionId: 's' }),
        requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'private-spawn-fixture' });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture control port');
    await mkdir(dirname(configuration.daemonStateFile), { recursive: true });
    writeDaemonState({ pid: process.pid, httpPort: address.port, startedAt: Date.now(), startedWithCliVersion: 'fixture',
        controlToken: 'private-spawn-fixture' });
    const requester = { accountId: 'a', custodianAccountId: 'a' };
    const initial = await view.watch({ machineId: 'm', scope: 'happier', view: 'tree' }, requester);
    const cancellation = new AbortController();
    let answer: MachineProcessesWatchResultV1 | undefined;
    const parked = view.watch({ machineId: 'm', scope: 'happier', view: 'tree', since: initial.changed ? initial.answer.capturedAtMs : 0 },
        requester, cancellation.signal).then(value => { answer = value; });
    await vi.advanceTimersByTimeAsync(1);
    const launched = spawnSupervisedPluginProcess({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: {} });
    childPid = launched.child.pid;
    try {
        await once(launched.child, 'spawn');
        await vi.waitFor(() => expect(answer?.changed).toBe(true));
        expect(Date.now()).toBeLessThan(2000);
        expect(answer?.changed && answer.answer.owners.flatMap(owner => owner.members).map(row => row.pid)).toContain(childPid);
        expect(MachineProcessesWatchResultV1Schema.safeParse(answer).success).toBe(true);
        const reads = boundary.read.mock.calls.length;
        view.dispose();
        const next = spawnSupervisedPluginProcess({ command: process.execPath, args: ['-e', 'process.exit(0)'], env: {} });
        await once(next.child, 'spawn');
        await next.handle.wait();
        await vi.advanceTimersByTimeAsync(1);
        expect(boundary.read.mock.calls.length).toBe(reads);
    } finally {
        cancellation.abort(); await parked;
        view.dispose(); pass.dispose();
        launched.child.kill('SIGKILL');
        await launched.handle.wait();
        vi.useRealTimers(); await sampler.stop();
        await app.close(); await clearDaemonStateForTestTeardown();
    }
});
it('samples only while watched, retaining CPU/history across re-arm until the shared watch window expires', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    let name = 'daemon';
    boundary.read.mockImplementation(async input => ({ status: 'ok', capturedAtMs: Date.now(), logicalCpus: 2, rows: [
        { pid: 100, ppid: 1, start: { startTimeMs: 100 }, principal: { kind: 'uid', value: '1000' }, name,
            memory: { bytes: input.pids ? 30 : 20, kind: 'rss' }, cpuTimeUs: Date.now() * 100 },
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
    const watched = view.watch({ machineId: 'm', scope: 'happier', view: 'tree',
        since: firstWatch.changed ? firstWatch.answer.capturedAtMs : initial.capturedAtMs }, requester, controller.signal);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(2000);
    const answer = await watched;
    expect(answer.changed).toBe(true);
    expect(localServiceRoutes.watcherCount()).toBe(0);
    const ref = initial.owners[0].members[0].ref;
    const rearmed = view.watch({ machineId: 'm', scope: 'happier', view: 'tree', since: Date.now(), detailToken: ref }, requester);
    await vi.advanceTimersByTimeAsync(2000);
    const second = await rearmed;
    expect(second.changed && second.answer.owners[0].members[0].cpuPercent).toBe(5);
    expect(second.changed && second.answer.owners[0].members[0].memoryBytes).toBe(30);
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
    expect((await view.get({ machineId: 'm', ref }, requester)).history).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(MACHINE_WATCH_WINDOW_MS);
    expect((await view.get({ machineId: 'm', ref }, requester)).history).toBeUndefined();
    const refreshed = await view.watch({ machineId: 'm', scope: 'happier', view: 'tree' }, requester);
    const cancellation = new AbortController();
    const parked = view.watch({ machineId: 'm', scope: 'happier', view: 'tree',
        since: refreshed.changed ? refreshed.answer.capturedAtMs : Date.now() }, requester, cancellation.signal);
    await vi.advanceTimersByTimeAsync(0);
    cancellation.abort();
    expect(await parked).toEqual({ changed: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(localServiceRoutes.watcherCount()).toBe(0);
    view.dispose(); pass.dispose(); await sampler.stop(); await rm(directory, { recursive: true, force: true });
});
