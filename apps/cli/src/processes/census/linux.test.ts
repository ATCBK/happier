import { describe, expect, it, vi } from 'vitest';
import { createLinuxCensusReader } from './linux';

function procStat(pid: number, cpu = 12, start = pid * 10) {
    return `${pid} (worker) ${['S', '1', '42', '42', '0', '42', ...Array(5).fill('0'), String(cpu), '8', ...Array(6).fill('0'), String(start), '4096', '3'].join(' ')}`;
}

describe('Linux census allocation cost', () => {
    it('decodes only changed rows across fresh thousand-process observations and keeps every OS read fresh', async () => {
        const pids = Array.from({ length: 1000 }, (_, index) => index + 42);
        const files = new Map<string, string | Buffer>();
        for (const pid of pids) {
            files.set(`/proc/${pid}/stat`, procStat(pid));
            files.set(`/proc/${pid}/status`, 'Uid:\t1000\n');
            files.set(`/proc/${pid}/cmdline`, 'worker\0argument\0');
            files.set(`/proc/${pid}/cgroup`, '0::/user.slice\n');
            files.set(`/proc/${pid}/environ`, 'SECRET=private\0HAPPIER_PROCESS_OWNER=owner\0HAPPIER_HOME_DIR=/home/user\0');
        }
        const auxv = Buffer.alloc(32);
        auxv.writeBigUInt64LE(6n, 0);
        auxv.writeBigUInt64LE(4096n, 8);
        files.set('/proc/self/auxv', auxv);
        const reads = new Map<string, number>();
        const denied = new Set<string>();
        const reader = createLinuxCensusReader({
            async readFile(path) {
                reads.set(path, (reads.get(path) ?? 0) + 1);
                if (denied.has(path)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
                const value = files.get(path);
                if (value === undefined) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
                return value;
            },
            async readdir() { return pids.map(String); },
            async readlink(path) { reads.set(path, (reads.get(path) ?? 0) + 1); return path.endsWith('/exe') ? '/usr/bin/worker' : '/work'; },
        });
        const input = { selfPid: 42, capturedAtMs: 1000, logicalCpus: 4 };
        const first = await reader(input);
        if (first.status !== 'ok') throw new Error('Initial fixture unavailable');
        let statDecodes = 0;
        let commandDecodes = 0;
        let environmentSplits = 0;
        const originalSplit = String.prototype.split;
        // Observe actual decoding allocations while retaining the real parser and OS-boundary fixture.
        const split = vi.spyOn(String.prototype, 'split').mockImplementation(function (this: string, ...args: Parameters<typeof originalSplit>) {
            if (String(this).startsWith('S 1 42 42 0 42 ')) statDecodes++;
            if (String(this) === 'worker\0argument\0') commandDecodes++;
            if (String(this).startsWith('SECRET=private\0')) environmentSplits++;
            return Reflect.apply(originalSplit, this, args);
        });
        try {
            const second = await reader({ ...input, capturedAtMs: 2000, previousRows: first.rows });
            if (second.status !== 'ok') throw new Error('Second fixture unavailable');
            expect(second.capturedAtMs).toBe(2000);
            expect({
                allocatedRows: second.rows.filter((row, index) => row !== first.rows[index]).length,
                statDecodes, commandDecodes, environmentSplits,
            }).toEqual({ allocatedRows: 0, statDecodes: 0, commandDecodes: 0, environmentSplits: 0 });
            expect(reads.get('/proc/100/stat')).toBe(2);
            expect(reads.get('/proc/100/status')).toBe(2);
            expect(reads.get('/proc/100/environ')).toBe(2);
            expect(reads.get('/proc/100/cmdline')).toBe(2);
            expect(reads.get('/proc/100/cgroup')).toBe(2);
            expect(reads.get('/proc/100/cwd')).toBe(2);
            expect(reads.get('/proc/100/exe')).toBe(2);
            files.set('/proc/100/stat', procStat(100, 13));
            const changed = await reader({ ...input, capturedAtMs: 3000, previousRows: second.rows });
            if (changed.status !== 'ok') throw new Error('Changed fixture unavailable');
            expect(changed.rows.filter((row, index) => row !== second.rows[index])).toHaveLength(1);
            const changedRow = changed.rows.find(row => row.pid === 100)!;
            const beforeRow = second.rows.find(row => row.pid === 100)!;
            expect(changedRow.cpuTimeUs).toBe(beforeRow.cpuTimeUs! + 10000);
            expect(changedRow.start).toBe(beforeRow.start);
            expect(changedRow.memory).toBe(beforeRow.memory);
            expect(changedRow.argv).toBe(beforeRow.argv);
            expect(changedRow.ownershipEnvironment).toBe(beforeRow.ownershipEnvironment);
            expect(statDecodes).toBeGreaterThan(0);
            expect(statDecodes).toBeLessThanOrEqual(3);
            expect(commandDecodes).toBe(0);
            expect(environmentSplits).toBe(0);
            files.set('/proc/100/stat', procStat(100, 13).replace(' 4096 3', ' 8192 3'));
            const unexposedStatChanged = await reader({ ...input, capturedAtMs: 4000, previousRows: changed.rows });
            if (unexposedStatChanged.status !== 'ok') throw new Error('Stat fixture unavailable');
            expect(unexposedStatChanged.rows.filter((row, index) => row !== changed.rows[index])).toHaveLength(0);
        } finally { split.mockRestore(); }

        const selected = { ...input, pids: [42, 100], previousRows: first.rows };
        files.set('/proc/100/environ', 'SECRET=changed-private\0HAPPIER_PROCESS_OWNER=new-owner\0HAPPIER_HOME_DIR= /new/home \0');
        files.set('/proc/100/cmdline', 'new-worker\0');
        const commandChanged = await reader(selected);
        expect(commandChanged.status === 'ok' && commandChanged.rows.find(row => row.pid === 100)).toMatchObject({
            argv: ['new-worker'], ownerTag: 'new-owner', ownershipEnvironment: { HAPPIER_HOME_DIR: '/new/home' },
        });
        if (commandChanged.status !== 'ok') throw new Error('Command fixture unavailable');
        denied.add('/proc/100/status');
        const unreadable = await reader({ ...selected, previousRows: commandChanged.rows });
        if (unreadable.status !== 'ok') throw new Error('Unreadable-principal fixture unavailable');
        const unknownPrincipal = unreadable.rows.find(row => row.pid === 100)!;
        expect(unknownPrincipal.principal).toBeNull();
        expect(unknownPrincipal.argv).toBeUndefined();
        expect(unknownPrincipal.ownershipEnvironment).toBeUndefined();
        expect(unreadable.partial).toContainEqual({ pid: 100, missing: ['status'] });
        denied.clear();
        files.delete('/proc/100/status');
        const vanishedStatus = await reader({ ...selected, previousRows: commandChanged.rows });
        expect(vanishedStatus.status === 'ok' && vanishedStatus.rows.some(row => row.pid === 100)).toBe(false);
        files.set('/proc/100/status', 'Uid:\t1000\n');
        files.set('/proc/100/environ', 'SECRET=still-private\0');
        const environmentRemoved = await reader(selected);
        if (environmentRemoved.status !== 'ok') throw new Error('Environment fixture unavailable');
        const withoutEnvironment = environmentRemoved.rows.find(row => row.pid === 100)!;
        expect(withoutEnvironment.ownerTag).toBeUndefined();
        expect(withoutEnvironment.ownershipEnvironment).toBeUndefined();
        files.set('/proc/100/status', 'Uid:\t2000\n');
        const principalChanged = await reader(selected);
        if (principalChanged.status !== 'ok') throw new Error('Principal fixture unavailable');
        const foreign = principalChanged.rows.find(row => row.pid === 100)!;
        expect(foreign.principal?.value).toBe('2000');
        expect(foreign.argv).toBeUndefined();
        expect(foreign.cwd).toBeUndefined();
        expect(foreign.executablePath).toBeUndefined();
        files.set('/proc/100/status', 'Uid:\t1000\n');
        files.set('/proc/100/stat', procStat(100, 0, 9999));
        const generationChanged = await reader(selected);
        if (generationChanged.status !== 'ok') throw new Error('Generation fixture unavailable');
        const recycled = generationChanged.rows.find(row => row.pid === 100)!;
        expect(recycled.start.native).toBe('linux-proc:9999');
        expect(recycled.start).not.toBe(withoutEnvironment.start);
        expect(recycled.cpuTimeUs).toBe(80000);
        const identity = await reader({ ...selected, fields: [] });
        expect(identity.status === 'ok' && identity.rows.find(row => row.pid === 100)).toMatchObject({ memory: null, cpuTimeUs: null });
        expect(identity.status === 'ok' && identity.rows.find(row => row.pid === 100)?.argv).toBeUndefined();
        const fullAgain = await reader(selected);
        expect(fullAgain.status === 'ok' && fullAgain.rows.find(row => row.pid === 100)).toMatchObject({ memory: { bytes: 12288 }, cpuTimeUs: 80000, argv: ['new-worker'] });
        files.delete('/proc/100/stat');
        const gone = await reader(selected);
        expect(gone.status === 'ok' && gone.rows.some(row => row.pid === 100)).toBe(false);
    });
});
