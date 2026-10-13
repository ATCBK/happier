import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProcessOwnershipRuntime } from '../ownership/processOwnershipRuntime';
import { createLeftBehindPass } from './leftBehindPass';
import { createGuardLeftBehindFixture, guardLeftBehindOwner } from '../../guard/actuators/leftBehind.testkit';

const owner = guardLeftBehindOwner;
function setup() {
    let live = false;
    let unavailable = false;
    let nativeReads = 0;
    const native = createGuardLeftBehindFixture();
    const laterChild = native.rows.get(301)!;
    native.rows.delete(301);
    const processOwnershipRuntime = createProcessOwnershipRuntime({ selfPid: process.pid, platform: 'darwin', daemonScopeKey: '123456789abc',
        // Only the native helper transport is substituted. The real census decoder,
        // identity checks, ownership and confirmation all consume its canonical fixture.
        censusDependencies: { ...native.censusDependencies, now: Date.now, execFile: async (...args) => {
            nativeReads++;
            if (unavailable) throw new Error('Native process table unavailable');
            native.advance(Date.now() - native.now());
            return native.censusDependencies.execFile!(...args);
        } },
        listRoots: () => [{ owner, pid: 200, start: { startTimeMs: 200 }, ownerCreatedAtMs: 200, live }] });
    return { pass: createLeftBehindPass({ processOwnershipRuntime }), processOwnershipRuntime,
        resume() { live = true; }, addChild() { native.rows.set(301, laterChild); }, fail() { unavailable = true; },
        get nativeReads() { return nativeReads; } };
}
afterEach(() => { vi.useRealTimers(); });
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
        const { pass, fail } = setup();
        await pass.firstPass(owner);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(pass.confirmed()).toHaveLength(1);
        fail();
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
        const f = setup();
        const { pass } = f;
        const observed = await f.processOwnershipRuntime.readOwners({ freshness: 'fresh' });
        const reads = f.nativeReads;
        pass.observe(observed);
        expect(f.nativeReads).toBe(reads);
        expect(pass.confirmed()).toEqual([]);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(pass.confirmed().map(item => item.pid)).toEqual([300]);
        pass.dispose();
    });
});
