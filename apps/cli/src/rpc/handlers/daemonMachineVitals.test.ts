import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RpcHandlerContext, RpcHandlerMap, RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createMachineVitalsSampler } from '@/daemon/vitals/createMachineVitalsSampler';
import { createMinuteHistoryStore } from '@/daemon/vitals/history/minuteHistoryStore';
import { createLinuxMachineVitalsReader } from '@/daemon/vitals/readers/linux';
import type { MachineVitalsReader, MachineVitalsReaderInput } from '@/daemon/vitals/readers/types';
import { MachineVitalsSnapshotV1Schema, MachineVitalsWatchResultV1Schema } from '@happier-dev/protocol/machines/vitals/machineVitalsRpcV1';
import { registerDaemonMachineVitalsRpcHandlers } from './daemonMachineVitals';

describe('Machine vitals Machine admission', () => {
    const directories: string[] = [];
    const samplers: ReturnType<typeof createMachineVitalsSampler>[] = [];
    const controllers: AbortController[] = [];
    const initialTime = Date.UTC(2026, 9, 10);
    const identity = { serverId: 's', machineId: 'm', installationId: 'i', custodianAccountId: 'owner' };
    afterEach(async () => {
        controllers.splice(0).forEach(controller => controller.abort());
        await Promise.all(samplers.splice(0).map(sampler => sampler.stop()));
        vi.useRealTimers();
        await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
    });
    async function setup(options: { readers?: MachineVitalsReader; target?: () => typeof identity } = {}) {
        const directory = await mkdtemp(join(tmpdir(), 'happier-vitals-rpc-'));
        directories.push(directory);
        const historyStore = await createMinuteHistoryStore({ directory });
        const sampler = createMachineVitalsSampler({ readers: options.readers ?? createLinuxMachineVitalsReader({ root: directory }), historyStore,
            monotonicMs: () => Date.now() - initialTime });
        samplers.push(sampler);
        // Match the canonical erased heterogeneous RPC transport registry.
        const handlers: RpcHandlerMap = new Map();
        const rpc: RpcHandlerRegistrar = { registerHandler(method, handler) { handlers.set(method, handler); } };
        registerDaemonMachineVitalsRpcHandlers(rpc, { sampler, target: options.target ?? (() => identity) });
        return { sampler, handlers };
    }
    function context(actorAccountId: string, role: 'use' | 'manage', verify = async () => true, controller = new AbortController()): RpcHandlerContext {
        controllers.push(controller);
        return { signal: controller.signal, machineAdmission: {
            machineId: 'm', installationId: 'i', custodianAccountId: 'owner', actorAccountId, role, encryptionMode: 'plain',
        // The real RPC transport also fails current-admission verification closed on cancellation.
        }, verifyMachineAdmissionCurrent: async () => !controller.signal.aborted && await verify() && !controller.signal.aborted };
    }
    async function sampledSetup() {
        vi.useFakeTimers();
        vi.setSystemTime(initialTime);
        const reads: MachineVitalsReaderInput[] = [];
        // Native OS readings are the system boundary; sampler, journal and RPC admission remain real.
        const readers: MachineVitalsReader = { async read(input) {
            reads.push(input);
            return {
                state: 'reporting', host: { logicalCores: 4, memoryTotalBytes: 1000, bootedAt: initialTime - 100_000 },
                sample: {
                    v: 1, sampledAt: input.sampledAt, intervalMs: input.intervalMs,
                    cpu: { reported: true, busyPct: 25 },
                    memory: { reported: true, totalBytes: 1000, availableBytes: 800, usedBytes: 200,
                        pressure: { level: 'calm', source: 'events' },
                        ...(input.overviewExtras ? { composition: [{ kind: 'apps' as const, bytes: 200 }] } : {}) },
                    disk: { reported: false, reason: 'unavailable' }, network: { reported: true, rxBps: 100, txBps: 50 },
                    limits: { files: { used: 1, max: 10 }, ...(input.overviewExtras ? { inotify: { used: 2, max: 20 } } : {}) },
                    ...(input.overviewExtras ? {
                        gpu: [{ name: 'gpu', busyPct: 20 }], battery: { pct: 80, state: 'charging' as const, onAC: true },
                        thermal: { state: 'nominal' as const }, sharedMemory: { totalBytes: 500, availableBytes: 400 },
                    } : {}),
                },
                minuteCounters: { monotonicMs: input.monotonicMs, cpu: { busy: input.monotonicMs / 4, total: input.monotonicMs },
                    network: { interfaceIds: ['eth0'], rxBytes: input.monotonicMs, txBytes: input.monotonicMs / 2 } },
            };
        } };
        const result = await setup({ readers });
        await result.sampler.start();
        return { ...result, reads };
    }
    async function advance(sampler: ReturnType<typeof createMachineVitalsSampler>, ms: number) {
        await vi.advanceTimersByTimeAsync(ms);
        await sampler.start();
    }
    it('admits custodians and Use recipients to content-free machine facts', async () => {
        const { handlers } = await setup();
        for (const admitted of [context('owner', 'manage'), context('recipient', 'use')]) {
            expect(await handlers.get(RPC_METHODS.MACHINES_VITALS_GET)!({ serverId: 's', machineId: 'm', view: 'summary' }, admitted))
                .toMatchObject({ state: 'reporting', sample: null, series5m: { cpu: [], memory: [] } });
            expect(await handlers.get(RPC_METHODS.MACHINES_VITALS_HISTORY_GET)!({ machineId: 'm', range: '1h' }, admitted))
                .toMatchObject({ range: '1h', today: { rxBytes: 0, txBytes: 0 } });
        }
    });
    it('reads vitals for a caller-local label of the admitted Home', async () => {
        const { handlers } = await setup({ target: () => ({ ...identity, serverId: 'daemon-home' }) });
        const admitted = context('recipient', 'use');
        expect(await handlers.get(RPC_METHODS.MACHINES_VITALS_GET)!({ serverId: 'browser-home', machineId: 'm' }, admitted))
            .toMatchObject({ state: 'reporting', sample: null });
    });
    it('refuses missing admission, another exact target and revoked access', async () => {
        const { handlers } = await setup();
        const read = handlers.get(RPC_METHODS.MACHINES_VITALS_GET)!;
        await expect(read({ machineId: 'm' })).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        await expect(read({ machineId: 'other' }, context('recipient', 'use'))).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        await expect(read({ machineId: 'm' }, context('recipient', 'use', async () => false))).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        await expect(read({ serverId: 'browser-home', machineId: 'm' }, context('recipient', 'use', async () => false))).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        for (const patch of [{ installationId: 'other' }, { custodianAccountId: 'other' }, { machineId: 'other' }, { actorAccountId: '' }]) {
            const admitted = context('recipient', 'use');
            await expect(read({ machineId: 'm' }, { ...admitted, machineAdmission: { ...admitted.machineAdmission!, ...patch } }))
                .rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        }
        await expect(read({ machineId: 'm' }, { ...context('recipient', 'use'), verifyMachineAdmissionCurrent: undefined }))
            .rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
    });
    it('reports the failed target or currentness predicate without private identity values', async () => {
        const { handlers } = await setup();
        const read = handlers.get(RPC_METHODS.MACHINES_VITALS_GET)!;
        const reportAdmissionDenial = vi.fn();
        const admitted = { ...context('recipient', 'use'), reportAdmissionDenial };
        await expect(read({ machineId: 'private-other-machine' }, admitted)).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        expect(reportAdmissionDenial.mock.calls).toEqual([['machine_request_target']]);
        reportAdmissionDenial.mockClear();
        await expect(read({ machineId: 'm' }, { ...admitted, machineAdmission: { ...admitted.machineAdmission!, installationId: 'private-old-installation' } }))
            .rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        expect(reportAdmissionDenial.mock.calls).toEqual([['machine_installation']]);
        reportAdmissionDenial.mockClear();
        await expect(read({ machineId: 'm' }, { ...admitted, verifyMachineAdmissionCurrent: async () => false }))
            .rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        expect(reportAdmissionDenial.mock.calls).toEqual([['machine_currentness']]);
        expect(JSON.stringify(reportAdmissionDenial.mock.calls)).not.toContain('private-');
    });
    it('rejects unknown or malformed inputs for every vitals entry point', async () => {
        const { handlers } = await setup();
        const admitted = context('recipient', 'use');
        for (const [method, request] of [
            [RPC_METHODS.MACHINES_VITALS_GET, { machineId: 'm', content: true }],
            [RPC_METHODS.MACHINES_VITALS_HISTORY_GET, { machineId: 'm', range: '1h', content: true }],
            [RPC_METHODS.DAEMON_VITALS_WATCH, { machineId: 'm', view: 'summary', content: true }],
            [RPC_METHODS.MACHINES_VITALS_GET, { machineId: 'm', view: 'anything' }],
            [RPC_METHODS.MACHINES_VITALS_HISTORY_GET, { machineId: 'm', range: 'forever' }],
            [RPC_METHODS.DAEMON_VITALS_WATCH, { machineId: 'm', view: 'summary', sinceSampledAt: -1 }],
        ] as const) await expect(handlers.get(method)!(request, admitted)).rejects.toMatchObject({ name: 'ZodError' });
    });
    it('rechecks installation and home binding after admission verification awaits', async () => {
        let target = identity;
        const { handlers } = await setup({ target: () => target });
        for (const replacement of [{ ...identity, installationId: 'replaced' }, { ...identity, serverId: 'another-home' }]) {
            target = identity;
            let resolveVerification!: (valid: boolean) => void;
            const verification = new Promise<boolean>(resolve => { resolveVerification = resolve; });
            const pending = handlers.get(RPC_METHODS.MACHINES_VITALS_GET)!({ serverId: 's', machineId: 'm' }, context('recipient', 'use', () => verification));
            const rejected = expect(pending).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
            target = replacement;
            resolveVerification(true);
            await rejected;
        }
    });
    it('does not acquire sampling demand for immediate get or history reads', async () => {
        const { sampler, handlers, reads } = await sampledSetup();
        const admitted = context('recipient', 'use');
        await handlers.get(RPC_METHODS.MACHINES_VITALS_GET)!({ machineId: 'm', view: 'overview' }, admitted);
        await handlers.get(RPC_METHODS.MACHINES_VITALS_HISTORY_GET)!({ machineId: 'm', range: '1h' }, admitted);
        await advance(sampler, 59_000);
        expect(reads.map(input => input.sampledAt)).toEqual([initialTime]);
        await advance(sampler, 1000);
        expect(reads.at(-1)).toMatchObject({ sampledAt: initialTime + 60_000, intervalMs: 60_000, overviewExtras: false });
    });
    it('rechecks revocation after a changed sample and releases parked demand', async () => {
        const { sampler, handlers, reads } = await sampledSetup();
        let valid = true;
        const pending = handlers.get(RPC_METHODS.DAEMON_VITALS_WATCH)!({ machineId: 'm', view: 'summary', sinceSampledAt: initialTime }, context('recipient', 'use', async () => valid));
        const rejected = expect(pending).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        await advance(sampler, 0);
        valid = false;
        await advance(sampler, 15_000);
        await rejected;
        await advance(sampler, 44_000);
        expect(reads.at(-1)?.sampledAt).toBe(initialTime + 15_000);
        await advance(sampler, 1000);
        expect(reads.at(-1)?.sampledAt).toBe(initialTime + 60_000);
    });
    it('releases cadence and extras demand when the RPC transport cancels a parked watch', async () => {
        const { sampler, handlers, reads } = await sampledSetup();
        const controller = new AbortController();
        const admitted = context('recipient', 'use', async () => true, controller);
        const pending = handlers.get(RPC_METHODS.DAEMON_VITALS_WATCH)!({ machineId: 'm', view: 'overview', sinceSampledAt: initialTime }, admitted);
        const rejected = expect(pending).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        await advance(sampler, 0);
        controller.abort();
        await rejected;
        await advance(sampler, 59_000);
        expect(reads.at(-1)?.sampledAt).toBe(initialTime);
        await advance(sampler, 1000);
        expect(reads.at(-1)).toMatchObject({ sampledAt: initialTime + 60_000, overviewExtras: false });
    });
    it('does not resolve summary watches on two-second live ticks', async () => {
        const { sampler, handlers } = await sampledSetup();
        const releaseLive = sampler.demand('live');
        try {
            let resolved = false;
            const pending = handlers.get(RPC_METHODS.DAEMON_VITALS_WATCH)!({ machineId: 'm', view: 'summary', sinceSampledAt: initialTime }, context('recipient', 'use'));
            void pending.then(() => { resolved = true; });
            await advance(sampler, 14_000);
            expect(sampler.latest()?.sampledAt).toBe(initialTime + 14_000);
            expect(resolved).toBe(false);
            await advance(sampler, 2000);
            expect(MachineVitalsWatchResultV1Schema.parse(await pending)).toMatchObject({ changed: true, samples: [{ sampledAt: initialTime + 16_000 }] });
        } finally { releaseLive(); }
    });
    it('never exposes cached Overview extras to summary get or watch results', async () => {
        const { sampler, handlers } = await sampledSetup();
        const releaseOverview = sampler.demandOverview();
        try {
            await advance(sampler, 0);
            const admitted = context('recipient', 'use');
            const overview = MachineVitalsSnapshotV1Schema.parse(await handlers.get(RPC_METHODS.MACHINES_VITALS_GET)!({ machineId: 'm', view: 'overview' }, admitted));
            expect(overview.sample).toMatchObject({ gpu: [{ name: 'gpu' }], battery: { pct: 80 }, thermal: { state: 'nominal' },
                sharedMemory: { totalBytes: 500 }, memory: { composition: [{ kind: 'apps' }] }, limits: { inotify: { used: 2 } } });
            const summary = MachineVitalsSnapshotV1Schema.parse(await handlers.get(RPC_METHODS.MACHINES_VITALS_GET)!({ machineId: 'm', view: 'summary' }, admitted));
            const pending = handlers.get(RPC_METHODS.DAEMON_VITALS_WATCH)!({ machineId: 'm', view: 'summary', sinceSampledAt: initialTime }, admitted);
            await advance(sampler, 16_000);
            const watched = MachineVitalsWatchResultV1Schema.parse(await pending);
            expect(watched.changed).toBe(true);
            if (!watched.changed) throw new Error('Expected summary samples');
            for (const sample of [summary.sample, ...watched.samples]) {
                expect(sample).toMatchObject({ limits: { files: { used: 1, max: 10 } } });
                for (const key of ['gpu', 'battery', 'thermal', 'sharedMemory']) expect(sample).not.toHaveProperty(key);
                expect(sample?.memory).not.toHaveProperty('composition');
                expect(sample?.limits).not.toHaveProperty('inotify');
            }
        } finally { releaseOverview(); }
    });
    it('keeps the fifteen-second extras budget across normal Overview watch re-arms', async () => {
        const { sampler, handlers, reads } = await sampledSetup();
        let cursor = initialTime;
        for (let cycle = 0; cycle < 8; cycle++) {
            const pending = handlers.get(RPC_METHODS.DAEMON_VITALS_WATCH)!({ machineId: 'm', view: 'overview', sinceSampledAt: cursor }, context('recipient', 'use'));
            await advance(sampler, 0);
            await advance(sampler, 2000);
            const result = MachineVitalsWatchResultV1Schema.parse(await pending);
            expect(result.changed).toBe(true);
            if (!result.changed) throw new Error('Expected Overview samples');
            cursor = result.samples.at(-1)!.sampledAt;
        }
        expect(reads.filter(input => input.overviewExtras).map(input => input.sampledAt)).toEqual([initialTime, initialTime + 15_000]);
    });
});
