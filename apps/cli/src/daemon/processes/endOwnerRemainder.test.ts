import { once } from 'node:events';
import { expect, it } from 'vitest';
import { createProcessOwnershipRuntime } from './ownership/processOwnershipRuntime';
import { createEndOwnerRemainder } from './endOwnerRemainder';
import { readProcessCensus } from '@/processes/census/processCensus';
import type { ProcessCensusDependencies } from '@/processes/census/processCensus';
import type { HappierProcessRoot } from './ownership/types';
import { spawnInlineNodeParentWithChild, waitForProcessExit } from '@/testkit/process/spawn';

it('retains only a captured ended subtree while its shared daemon owner remains live', async () => {
    const { parent, childPid } = await spawnInlineNodeParentWithChild();
    const owner = { kind: 'happier' } as const;
    const initial = await readProcessCensus({ freshness: 'fresh', scope: 'all' });
    if (initial.status !== 'ok') throw new Error('Native census unavailable');
    const self = initial.rows.find(row => row.pid === process.pid)!;
    const daemonRoot: HappierProcessRoot = { owner, pid: self.pid, start: self.start, live: true, ownerCreatedAtMs: 0 };
    const runtime = createProcessOwnershipRuntime({ daemonScopeKey: '123456789abc', listRoots: () => [daemonRoot] });
    const retained: HappierProcessRoot[] = [];
    const remainder = createEndOwnerRemainder({ processOwnershipRuntime: runtime, daemonScopeKey: '123456789abc',
        retainEndedRoots: roots => { retained.push(...roots); }, firstPass: () => {} });
    try {
        const capture = await remainder.captureTree(owner, { pid: parent.pid! });
        expect(capture?.roots.map(root => root.pid).sort()).toEqual([parent.pid!, childPid].sort());
        const exited = once(parent, 'exit'); parent.kill('SIGKILL'); await exited;
        await remainder.observeEnd(owner, capture);
        expect(retained.map(root => root.pid).sort()).toEqual([parent.pid!, childPid].sort());
        expect(retained.every(root => !root.live)).toBe(true);
        expect(() => process.kill(childPid, 0)).not.toThrow();
    } finally {
        parent.kill('SIGKILL');
        try { process.kill(childPid, 'SIGKILL'); } catch { /* owned probe only */ }
    }
}, 15_000);

it('observes an ended terminal without terminating its surviving child', async () => {
    const { parent, childPid } = await spawnInlineNodeParentWithChild();
    const owner = { kind: 'terminal', terminalId: 'terminal-remainder-probe' } as const;
    const initial = await readProcessCensus({ freshness: 'fresh', scope: 'all' });
    if (initial.status !== 'ok') throw new Error('Native census unavailable');
    const root = initial.rows.find(row => row.pid === parent.pid)!;
    const runtime = createProcessOwnershipRuntime({ daemonScopeKey: '123456789abc', listRoots: () => [] });
    const retained: HappierProcessRoot[] = [];
    let observed = false;
    const remainder = createEndOwnerRemainder({ processOwnershipRuntime: runtime, daemonScopeKey: '123456789abc',
        retainEndedRoots: roots => { retained.push(...roots); }, firstPass: () => { observed = true; } });
    try {
        const exited = once(parent, 'exit'); parent.kill('SIGKILL'); await exited;
        await remainder.observeEnd(owner, { roots: [{ owner, pid: root.pid, start: root.start, live: true, ownerCreatedAtMs: 0 }], ownership: [] });
        expect(retained).toMatchObject([{ owner, live: false }]);
        expect(observed).toBe(true);
        expect(() => process.kill(childPid, 0)).not.toThrow();
    } finally {
        parent.kill('SIGKILL');
        try { process.kill(childPid, 'SIGKILL'); } catch { /* owned probe only */ }
    }
}, 15_000);

it('ends an unmarked reparented child using captured generation-bound pre-exit chain evidence', async () => {
    const { parent, childPid } = await spawnInlineNodeParentWithChild();
    const owner = { kind: 'session', sessionId: 'remainder-probe' } as const;
    const initial = await readProcessCensus({ freshness: 'fresh', scope: 'all' });
    if (initial.status !== 'ok') throw new Error('Native census unavailable');
    const root = initial.rows.find(row => row.pid === parent.pid)!;
    const runtime = createProcessOwnershipRuntime({ daemonScopeKey: '123456789abc', listRoots: () => [{
        owner, pid: root.pid, start: root.start, live: parent.exitCode === null && parent.signalCode === null,
        ownerCreatedAtMs: 0,
    }] });
    const firstPassOwners: string[] = [];
    const remainder = createEndOwnerRemainder({ processOwnershipRuntime: runtime, daemonScopeKey: '123456789abc',
        firstPass: value => { firstPassOwners.push(value.kind); } });
    try {
        const captured = await remainder.capture(owner);
        expect(captured?.ownership.find(row => row.pid === childPid)?.level).toBe('proven');
        const departed = once(parent, 'exit');
        parent.kill('SIGKILL');
        await departed;
        const result = await remainder.end(owner, captured);
        expect(result).toMatchObject({ status: 'complete', outcomes: [{ pid: childPid, outcome: 'ended' }] });
        await waitForProcessExit(childPid, { timeoutMs: 2000 });
        expect(firstPassOwners).toEqual(['session']);
    } finally {
        parent.kill('SIGKILL');
        try { process.kill(childPid, 'SIGKILL'); } catch { /* disposable probe may already have ended */ }
    }
}, 15_000);

it('does not sweep a new live owner sharing the old physical fence', async () => {
    const oldOwner = { kind: 'session', sessionId: 'old-owner' } as const;
    const newOwner = { kind: 'session', sessionId: 'new-owner' } as const;
    const scope = '123456789abc';
    const rows = new Map([
        [process.pid, { parent: 1, ticks: 10, cgroup: '', tag: '' }],
        [4100, { parent: 1, ticks: 100, cgroup: '/old-fence', tag: `v1.${scope}.session.old-owner` }],
        [4101, { parent: 4100, ticks: 110, cgroup: '/old-fence', tag: `v1.${scope}.session.old-owner` }],
    ]);
    const censusDependencies: ProcessCensusDependencies = { platform: 'linux', selfPid: process.pid, linuxBoundary: {
        async readdir() { return [...rows.keys()].map(String); },
        async readlink() { return '/fixture'; },
        async readFile(path) {
            const row = rows.get(Number(path.split('/')[2]));
            if (!row) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
            if (path.endsWith('/status')) return 'Uid:\t1000\n';
            if (path.endsWith('/stat')) return `${path.split('/')[2]} (fixture) ${['S', String(row.parent), '5000', '1', '0', '0', ...Array(13).fill('0'), String(row.ticks), '0', '0'].join(' ')}`;
            if (path.endsWith('/environ')) return row.tag ? `HAPPIER_PROCESS_OWNER=${row.tag}\0` : '';
            if (path.endsWith('/cgroup')) return row.cgroup ? `0::${row.cgroup}\n` : '';
            return '';
        },
    } };
    const oldRoot: HappierProcessRoot = { owner: oldOwner, pid: 4100, start: { startTimeMs: 1000 }, live: true,
        ownerCreatedAtMs: 0, ownerCreatedStartTimeMs: 1000, containment: { kind: 'linux_unit', prefix: '/old-fence' } };
    let roots: readonly HappierProcessRoot[] = [oldRoot];
    const runtime = createProcessOwnershipRuntime({ platform: 'linux', daemonScopeKey: scope,
        censusDependencies, listRoots: () => roots });
    const signals: number[] = [];
    const remainder = createEndOwnerRemainder({ platform: 'linux', processOwnershipRuntime: runtime, daemonScopeKey: scope,
        firstPass: () => {}, systemBoundary: { platform: 'linux', censusDependencies,
            kill(pid) { signals.push(pid); rows.delete(pid); return true; } } });
    const captured = await remainder.capture(oldOwner);
    roots = [{ ...oldRoot, live: false }, { ...oldRoot, owner: newOwner, live: true, containment: undefined }];
    rows.set(4101, { parent: 1, ticks: 110, cgroup: '', tag: `v1.${scope}.session.old-owner` });
    const result = await remainder.end(oldOwner, captured);
    expect(result).toMatchObject({ status: 'complete', outcomes: [{ pid: 4101, outcome: 'ended' }] });
    expect(signals).toEqual([4101]);
    expect(rows.has(4100)).toBe(true);
});

it('does not retire a resumed live owner generation while completing an older runner exit', async () => {
    const old = await spawnInlineNodeParentWithChild();
    const resumed = await spawnInlineNodeParentWithChild();
    const owner = { kind: 'session', sessionId: 'resumed-remainder-probe' } as const;
    const snapshot = await readProcessCensus({ freshness: 'fresh', scope: 'all' });
    if (snapshot.status !== 'ok') throw new Error('Native census unavailable');
    const oldRoot = snapshot.rows.find(row => row.pid === old.parent.pid)!;
    const newRoot = snapshot.rows.find(row => row.pid === resumed.parent.pid)!;
    let current = oldRoot;
    const runtime = createProcessOwnershipRuntime({ daemonScopeKey: '123456789abc', listRoots: () => [{
        owner, pid: current.pid, start: current.start, live: true, ownerCreatedAtMs: 0,
    }] });
    const remainder = createEndOwnerRemainder({ processOwnershipRuntime: runtime, daemonScopeKey: '123456789abc', firstPass: () => {} });
    try {
        const capture = await remainder.capture(owner);
        const exited = once(old.parent, 'exit'); old.parent.kill('SIGKILL'); await exited;
        current = newRoot;
        expect(await remainder.end(owner, capture)).toMatchObject({ status: 'complete', outcomes: [] });
        const after = await readProcessCensus({ freshness: 'fresh', pids: [resumed.childPid, resumed.parent.pid!] });
        expect(after.status === 'ok' && after.rows.filter(row => [resumed.parent.pid, resumed.childPid].includes(row.pid) && row.state !== 'zombie')).toHaveLength(2);
    } finally {
        old.parent.kill('SIGKILL'); resumed.parent.kill('SIGKILL');
        for (const pid of [old.childPid, resumed.childPid]) { try { process.kill(pid, 'SIGKILL'); } catch { /* owned probes only */ } }
    }
}, 15_000);

it('refuses a fence whose root changes live owner after the initial exclusive proof', async () => {
    const oldOwner = { kind: 'session', sessionId: 'old-owner' } as const;
    const newOwner = { kind: 'session', sessionId: 'new-owner' } as const;
    const scope = '123456789abc';
    const rows = new Map([[process.pid, { parent: 1, ticks: 10, cgroup: '' }],
        [4100, { parent: 1, ticks: 100, cgroup: '/old-fence' }], [4101, { parent: 4100, ticks: 110, cgroup: '/old-fence' }]]);
    const oldRoot: HappierProcessRoot = { owner: oldOwner, pid: 4100, start: { startTimeMs: 1000 }, live: false,
        ownerCreatedAtMs: 0, containment: { kind: 'linux_unit', prefix: '/old-fence' } };
    let roots: readonly HappierProcessRoot[] = [oldRoot];
    let reads = 0;
    const censusDependencies: ProcessCensusDependencies = { platform: 'linux', selfPid: process.pid, linuxBoundary: {
        async readdir() {
            if (++reads >= 2) roots = [oldRoot, { ...oldRoot, owner: newOwner, live: true, containment: undefined }];
            return [...rows.keys()].map(String);
        },
        async readlink() { return '/fixture'; },
        async readFile(path) {
            const row = rows.get(Number(path.split('/')[2]));
            if (!row) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
            if (path.endsWith('/status')) return 'Uid:\t1000\n';
            if (path.endsWith('/stat')) return `${path.split('/')[2]} (fixture) ${['S', String(row.parent), '5000', '1', '0', '0', ...Array(13).fill('0'), String(row.ticks), '0', '0'].join(' ')}`;
            if (path.endsWith('/cgroup')) return row.cgroup ? `0::${row.cgroup}\n` : '';
            return '';
        },
    } };
    const runtime = createProcessOwnershipRuntime({ platform: 'linux', daemonScopeKey: scope, censusDependencies, listRoots: () => roots });
    const signals: number[] = [];
    const remainder = createEndOwnerRemainder({ platform: 'linux', processOwnershipRuntime: runtime, daemonScopeKey: scope,
        firstPass: () => {}, systemBoundary: { platform: 'linux', censusDependencies,
            kill(pid) { signals.push(pid); rows.delete(pid); return true; } } });
    const result = await remainder.end(oldOwner);
    expect(result.status).toBe('incomplete');
    expect(signals).toEqual([]);
    expect(rows.has(4100)).toBe(true);
});
