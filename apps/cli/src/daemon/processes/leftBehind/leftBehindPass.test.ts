import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProcessCensusSnapshot } from '@/processes/census/processCensus';
import { createProcessOwnershipRuntime } from '../ownership/processOwnershipRuntime';
import { createLeftBehindPass } from './leftBehindPass';

// The native process-table read is the system boundary; ownership and lifecycle logic remain real.
const boundary = vi.hoisted(() => ({ read: vi.fn<() => Promise<ProcessCensusSnapshot>>() }));
vi.mock('@/processes/census/processCensus', () => ({ readProcessCensus: boundary.read }));
const owner = { kind: 'session', sessionId: 'ended' } as const;
const principal = { kind: 'uid', value: '1000' } as const;
function setup() {
    let live = false;
    let secondChild = false;
    boundary.read.mockImplementation(async () => ({ status: 'ok', capturedAtMs: Date.now(), logicalCpus: 1,
        rows: [
            { pid: 100, ppid: 1, start: { startTimeMs: 100 }, principal, name: 'daemon', memory: null, cpuTimeUs: null },
            { pid: 300, ppid: 1, start: { startTimeMs: 300, native: 'darwin-proc:300:0:300' }, principal,
                name: 'child', ownerTag: 'v1.123456789abc.session.ended', memory: null, cpuTimeUs: null },
            ...(secondChild ? [{ pid: 301, ppid: 1, start: { startTimeMs: 301, native: 'darwin-proc:301:0:301' }, principal,
                name: 'later child', ownerTag: 'v1.123456789abc.session.ended', memory: null, cpuTimeUs: null }] : []),
        ] }));
    const processOwnershipRuntime = createProcessOwnershipRuntime({ selfPid: 100, platform: 'darwin', daemonScopeKey: '123456789abc',
        listRoots: () => [{ owner, pid: 200, start: { startTimeMs: 200 }, ownerCreatedAtMs: 200, live }] });
    return { pass: createLeftBehindPass({ processOwnershipRuntime }), resume() { live = true; }, addChild() { secondChild = true; } };
}
afterEach(() => { vi.useRealTimers(); boundary.read.mockReset(); });
describe('owner-end and daemon-start left-behind pass', () => {
    it('automatically confirms a startup-discovered ended owner only after a fresh second read', async () => {
        vi.useFakeTimers(); vi.setSystemTime(1000);
        const { pass } = setup();
        await pass.firstPass();
        expect(pass.confirmed()).toEqual([]);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(pass.confirmed()).toMatchObject([{ pid: 300, owner }]);
        pass.dispose();
    });
    it('never offers a resumed owner and disposes scheduled reads on shutdown', async () => {
        vi.useFakeTimers(); vi.setSystemTime(1000);
        const { pass, resume } = setup();
        await pass.firstPass(owner); resume();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(pass.confirmed()).toEqual([]);
        await pass.firstPass(owner); pass.dispose();
        expect(vi.getTimerCount()).toBe(0);
    });
    it('reports unavailable fresh evidence instead of returning a retained confirmed list as current', async () => {
        vi.useFakeTimers(); vi.setSystemTime(1000);
        const { pass } = setup();
        await pass.firstPass(owner);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(pass.confirmed()).toHaveLength(1);
        boundary.read.mockResolvedValue({ status: 'unavailable', reason: 'read_failed' });
        expect(await pass.readConfirmed()).toEqual({ status: 'unavailable', reason: 'read_failed' });
        pass.dispose();
    });
    it('confirms a later candidate of the same ended owner after its own full interval', async () => {
        vi.useFakeTimers(); vi.setSystemTime(1000);
        const { pass, addChild } = setup();
        await pass.firstPass(owner);
        await vi.advanceTimersByTimeAsync(30_000);
        addChild(); await pass.firstPass(owner);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(pass.confirmed().map(item => item.pid)).toEqual([300]);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(pass.confirmed().map(item => item.pid)).toEqual([300, 301]);
        expect(vi.getTimerCount()).toBe(0);
        pass.dispose();
    });
    it('consumes watched ownership observations without issuing a second census and preserves confirmation spacing', async () => {
        vi.useFakeTimers(); vi.setSystemTime(1000);
        const { pass } = setup();
        const runtime = createProcessOwnershipRuntime({ selfPid: 100, platform: 'darwin', daemonScopeKey: '123456789abc',
            listRoots: () => [{ owner, pid: 200, start: { startTimeMs: 200 }, ownerCreatedAtMs: 200, live: false }] });
        const observed = await runtime.readOwners({ freshness: 'fresh' });
        const reads = boundary.read.mock.calls.length;
        pass.observe(observed);
        expect(boundary.read.mock.calls.length).toBe(reads);
        expect(pass.confirmed()).toEqual([]);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(pass.confirmed().map(item => item.pid)).toEqual([300]);
        pass.dispose();
    });
});
