import { once } from 'node:events';
import { expect, it } from 'vitest';
import { createProcessOwnershipRuntime } from './ownership/processOwnershipRuntime';
import { createEndOwnerRemainder } from './endOwnerRemainder';
import { readProcessCensus } from '@/processes/census/processCensus';
import type { ProcessCensusDependencies } from '@/processes/census/processCensus';
import type { HappierProcessRoot } from './ownership/types';
import { spawnInlineNodeParentWithChild, waitForProcessExit } from '@/testkit/process/spawn';
import { createStopSession } from '../sessions/stopSession';
import { waitForTrackedRunnerProcessesExit } from '../sessions/waitForTrackedRunnerProcessesExit';
import { listHappierProcessRoots } from './roots/listHappierProcessRoots';
import { createLeftBehindPass } from './leftBehind/leftBehindPass';
import type { TrackedSession } from '../types';
import { formatProcessOwnerTag, resolveProcessOwnerScopeKey } from '@/processes/ownerTag';
import { spawn } from 'node:child_process';

it.each(['absent', 'zombie', 'unreadable'] as const)('settles a departed captured tree using its native evidence (%s)', async state => {
    const owner = { kind: 'session', sessionId: 'departed-tree' } as const;
    let censusReads = 0;
    const censusDependencies: ProcessCensusDependencies = { platform: 'linux', selfPid: process.pid, linuxBoundary: {
        async readdir() { censusReads++; return [String(process.pid), ...(state === 'absent' ? [] : ['5100'])]; },
        async readlink() { return '/fixture'; },
        async readFile(path) {
            const pid = Number(path.split('/')[2]);
            if (pid === 5100 && state === 'unreadable') throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
            if (path.endsWith('/status')) return 'Uid:\t1000\n';
            if (path.endsWith('/stat')) return pid + ' (fixture) ' + [pid === 5100 ? 'Z' : 'S', '1', '5000', '1', '0', '0',
                ...Array(13).fill('0'), pid === 5100 ? '110' : '10', '0', '0'].join(' ');
            return '';
        },
    } };
    const runtime = createProcessOwnershipRuntime({ platform: 'linux', daemonScopeKey: '123456789abc',
        censusDependencies, listRoots: () => [] });
    const signals: number[] = [];
    const remainder = createEndOwnerRemainder({ platform: 'linux', processOwnershipRuntime: runtime,
        daemonScopeKey: '123456789abc', firstPass: () => {}, systemBoundary: { platform: 'linux', censusDependencies,
            kill(pid) { signals.push(pid); return true; } } });
    const roots = Array.from({ length: 70 }, (_, index): HappierProcessRoot => ({ owner, pid: 5100 + index,
        start: { startTimeMs: 1100 + index }, live: true, ownerCreatedAtMs: 0 }));
    const result = await remainder.end(owner, { scope: 'subtree', ownership: [], roots });
    expect(result.outcomes).toHaveLength(roots.length);
    expect(signals).toEqual([]);
    if (state === 'unreadable') {
        expect(result.status).toBe('incomplete');
        expect(result.outcomes).toContainEqual({ pid: 5100, outcome: 'refused', reason: 'identity_unavailable' });
        return;
    }
    expect(result.status).toBe('complete');
    expect(result.outcomes.every(outcome => outcome.outcome === 'gone_before')).toBe(true);
    // A fresh complete census already proves all captured generations absent.
    // Repeating whole-machine reads per departed PID delays the owning respawn.
    expect(censusReads).toBe(1);
});

it('protects a captured generation reowned during the final native identity read while retiring other targets', async () => {
    const owner = { kind: 'session', sessionId: 'departed' } as const;
    const root: HappierProcessRoot = { owner: { kind: 'session', sessionId: 'resumed' },
        pid: 5101, start: { startTimeMs: 1100 }, live: true, ownerCreatedAtMs: 0 };
    const rows = new Map([[process.pid, { parent: 1, ticks: 10 }],
        [5101, { parent: 1, ticks: 110 }], [5102, { parent: 1, ticks: 120 }]]);
    let rootReads = 0;
    let reowned = false;
    const censusDependencies: ProcessCensusDependencies = { platform: 'linux', selfPid: process.pid, linuxBoundary: {
        async readdir() { return [...rows.keys()].map(String); }, async readlink() { return '/fixture'; },
        async readFile(path) {
            const pid = Number(path.split('/')[2]);
            const row = rows.get(pid);
            if (!row) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
            if (path.endsWith('/status')) return 'Uid:\t1000\n';
            if (path.endsWith('/stat')) {
                if (pid === root.pid && rootReads === 3) reowned = true;
                return pid + ' (fixture) ' + ['S', String(row.parent), '5000', '1', '0', '0',
                    ...Array(13).fill('0'), String(row.ticks), '0', '0'].join(' ');
            }
            return '';
        },
    } };
    const runtime = createProcessOwnershipRuntime({ platform: 'linux', daemonScopeKey: '123456789abc', censusDependencies,
        listRoots: () => { rootReads++; return reowned ? [root] : []; } });
    const signals: number[] = [];
    const remainder = createEndOwnerRemainder({ platform: 'linux', processOwnershipRuntime: runtime,
        daemonScopeKey: '123456789abc', firstPass: () => {}, systemBoundary: { platform: 'linux', censusDependencies,
            kill(pid) { signals.push(pid); rows.delete(pid); return true; } } });
    const result = await remainder.end(owner, { scope: 'subtree', ownership: [], roots: [
        { ...root, owner, pid: 5102, start: { startTimeMs: 1200 } }, { ...root, owner },
    ] });
    expect(reowned).toBe(true);
    expect(signals).toEqual([5102]);
    expect(result).toMatchObject({ status: 'incomplete', outcomes: expect.arrayContaining([
        { pid: 5101, outcome: 'refused', reason: 'containment_authority_changed' }, { pid: 5102, outcome: 'ended' },
    ]) });
});

it('retires other captured targets while preserving a live reowned root and its subtree', async () => {
    const owner = { kind: 'session', sessionId: 'departed' } as const;
    const root: HappierProcessRoot = { owner: { kind: 'session', sessionId: 'resumed' },
        pid: 5101, start: { startTimeMs: 1100 }, live: true, ownerCreatedAtMs: 0 };
    const rows = new Map([[process.pid, { parent: 1, ticks: 10 }],
        [5101, { parent: 1, ticks: 110 }], [5102, { parent: 1, ticks: 120 }],
        [5103, { parent: 5101, ticks: 130 }]]);
    const censusDependencies: ProcessCensusDependencies = { platform: 'linux', selfPid: process.pid, linuxBoundary: {
        async readdir() { return [...rows.keys()].map(String); }, async readlink() { return '/fixture'; },
        async readFile(path) {
            const pid = Number(path.split('/')[2]);
            const row = rows.get(pid);
            if (!row) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
            if (path.endsWith('/status')) return 'Uid:\t1000\n';
            if (path.endsWith('/stat')) return pid + ' (fixture) ' + ['S', String(row.parent), '5000', '1', '0', '0',
                ...Array(13).fill('0'), String(row.ticks), '0', '0'].join(' ');
            return '';
        },
    } };
    const runtime = createProcessOwnershipRuntime({ platform: 'linux', daemonScopeKey: '123456789abc', censusDependencies,
        listRoots: () => [root] });
    const signals: number[] = [];
    const retained: HappierProcessRoot[] = [];
    const remainder = createEndOwnerRemainder({ platform: 'linux', processOwnershipRuntime: runtime,
        daemonScopeKey: '123456789abc', firstPass: () => {}, retainEndedRoots: roots => { retained.push(...roots); },
        systemBoundary: { platform: 'linux', censusDependencies,
            kill(pid) { signals.push(pid); rows.delete(pid); return true; } } });
    const result = await remainder.end(owner, { scope: 'subtree', ownership: [], roots: [5101, 5102, 5103].map(pid => ({
        ...root, owner, pid, start: { startTimeMs: rows.get(pid)!.ticks * 10 },
    })) });
    expect(result).toMatchObject({ status: 'complete', outcomes: [{ pid: 5102, outcome: 'ended' }] });
    expect(signals).toEqual([5102]);
    expect([...rows.keys()].sort()).toEqual([process.pid, 5101, 5103].sort());
    expect(retained.map(root => root.pid)).toEqual([5102]);
});

it.each(['exit', 'stop'] as const)('retires a Run-tagged native child with its captured Session generation after refresh (%s)', async retirement => {
    const happierHomeDir = '/fixture/refresh-run-remainder';
    const scope = resolveProcessOwnerScopeKey(happierHomeDir);
    const owner = { kind: 'session', sessionId: 'refresh-run-remainder' } as const;
    const run = { kind: 'run', runId: 'review-native' } as const;
    const parent = spawn(process.execPath, ['-e', `
        const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
            detached: true, stdio: 'ignore', env: { ...process.env, HAPPIER_PROCESS_OWNER: ${JSON.stringify(formatProcessOwnerTag({ happierHomeDir, owner: run }))} }
        });
        process.stdout.write(String(child.pid) + '\\n');
        setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    const childPid = await new Promise<number>(resolve => parent.stdout.once('data', data => resolve(Number(String(data).trim()))));
    try {
        const initial = await readProcessCensus({ freshness: 'fresh', scope: 'all' });
        if (initial.status !== 'ok') throw new Error('Native census unavailable');
        const native = initial.rows.find(row => row.pid === parent.pid)!;
        const root: HappierProcessRoot = { owner, pid: native.pid, start: native.start, live: true, ownerCreatedAtMs: 0 };
        let roots: readonly HappierProcessRoot[] = [root, { ...root, owner: run }];
        const runtime = createProcessOwnershipRuntime({ daemonScopeKey: scope, listRoots: () => roots });
        const remainder = createEndOwnerRemainder({ processOwnershipRuntime: runtime, daemonScopeKey: scope, firstPass: () => {} });
        const captured = await remainder.captureTree(owner, { pid: native.pid, start: native.start });
        const departed = once(parent, 'exit'); parent.kill('SIGKILL'); await departed;
        // A new live Session incarnation must neither hide the retired tree nor
        // become a target of its generation-specific physical cleanup.
        const self = initial.rows.find(row => row.pid === process.pid)!;
        roots = [{ ...root, live: false }, { ...root, owner: run, live: false },
            { ...root, pid: self.pid, start: self.start }];
        if (retirement === 'exit') {
            const result = await remainder.end(owner, captured);
            expect(result.outcomes).toContainEqual(expect.objectContaining({ pid: childPid, outcome: 'ended' }));
        } else {
            const tracked: TrackedSession = { pid: native.pid, processStartTimeMs: native.start.startTimeMs,
                happySessionId: owner.sessionId, startedBy: 'daemon', ownerRemainderCapture: captured };
            const stop = createStopSession({ pidToTrackedSession: new Map([[native.pid, tracked]]), ownerRemainder: remainder,
                areTrackedRunnersExited: async () => true, waitForTrackedRunnersExit: async () => true });
            expect(await stop(owner.sessionId)).toEqual({ status: 'stopped' });
        }
        expect(await waitForProcessExit(childPid, { timeoutMs: 2000 })).toBe(true);
        expect(() => process.kill(process.pid, 0)).not.toThrow();
    } finally {
        parent.kill('SIGKILL');
        try { process.kill(childPid, 'SIGKILL'); } catch { /* Exact owned native fixture. */ }
        await waitForProcessExit(childPid);
    }
}, 15_000);

it('keeps the Stop receipt incomplete when a captured child actually survives both signals', async () => {
    const { parent, childPid } = await spawnInlineNodeParentWithChild();
    const sessionId = 'surviving-remainder-stop';
    const initial = await readProcessCensus({ freshness: 'fresh', scope: 'all' });
    if (initial.status !== 'ok') throw new Error('Native census unavailable');
    const root = initial.rows.find(row => row.pid === parent.pid)!;
    const tracked: TrackedSession = { pid: root.pid, processStartTimeMs: root.start.startTimeMs,
        happySessionId: sessionId, startedBy: 'daemon', childProcess: parent };
    const sessions = new Map([[root.pid, tracked]]);
    const runtime = createProcessOwnershipRuntime({ daemonScopeKey: '123456789abc',
        listRoots: snapshot => listHappierProcessRoots({ snapshot, trackedSessions: sessions.values() }) });
    const leftBehind = createLeftBehindPass({ processOwnershipRuntime: runtime });
    const nativeKill = process.kill.bind(process);
    // Genuine signal boundary: acknowledge signals to this exact child without
    // delivering them. Native observations must still find the live generation.
    const remainder = createEndOwnerRemainder({ processOwnershipRuntime: runtime, daemonScopeKey: '123456789abc',
        firstPass: leftBehind.firstPass, systemBoundary: { kill: (pid, signal) => pid === childPid ? true : nativeKill(pid, signal) } });
    try {
        const captured = await remainder.capture({ kind: 'session', sessionId });
        expect(captured?.ownership.some(row => row.pid === childPid && row.level === 'proven')).toBe(true);
        const exited = once(parent, 'exit'); parent.kill('SIGKILL'); await exited;
        // The exit observer uses this pre-exit capture to retain unmarked lineage.
        tracked.ownerRemainderResult = await remainder.end({ kind: 'session', sessionId }, captured);
        expect(tracked.ownerRemainderResult).toMatchObject({ status: 'incomplete',
            outcomes: [{ pid: childPid, outcome: 'survived' }] });
        expect(nativeKill(childPid, 0)).toBe(true);
        const physicallyExited = async ({ trackedPids }: Readonly<{ trackedPids: readonly number[] }>) =>
            await waitForTrackedRunnerProcessesExit({ runners: trackedPids.map(pid => ({ pid })), timeoutMs: 0, pollIntervalMs: 0 });
        const stop = createStopSession({ pidToTrackedSession: sessions, ownerRemainder: remainder,
            areTrackedRunnersExited: physicallyExited, waitForTrackedRunnersExit: physicallyExited });
        await expect(stop(sessionId)).resolves.toMatchObject({ status: 'incomplete', reason: 'runner_signal_incomplete' });
    } finally {
        leftBehind.dispose();
        parent.kill('SIGKILL');
        try { nativeKill(childPid, 'SIGKILL'); } catch { /* Exact test-owned child only. */ }
        await waitForProcessExit(childPid);
    }
});

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

it.each(['Z', 'S', 'exits_during_grace'] as const)('requires ownership after enrichment disappears only for still-live members (%s)', async (stateAfterSignal) => {
    const owner = { kind: 'session', sessionId: 'exiting-remainder' } as const;
    const scope = '123456789abc';
    const rows = new Map([
        [process.pid, { parent: 1, ticks: 10, state: 'S' }],
        [4100, { parent: 1, ticks: 100, state: 'S' }],
        [4101, { parent: 4100, ticks: 110, state: 'S' }],
        [4102, { parent: 1, ticks: 120, state: 'S' }],
    ]);
    const enrichmentLost = new Set<number>();
    const censusDependencies: ProcessCensusDependencies = { platform: 'linux', selfPid: process.pid, linuxBoundary: {
        async readdir() { return [...rows.keys()].map(String); },
        async readlink() { return '/fixture'; },
        async readFile(path) {
            const pid = Number(path.split('/')[2]);
            const row = rows.get(pid);
            if (!row) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
            if (path.endsWith('/status')) return 'Uid:\t1000\n';
            if (path.endsWith('/stat')) return `${pid} (fixture) ${[row.state, String(row.parent), '5000', '1', '0', '0', ...Array(13).fill('0'), String(row.ticks), '0', '0'].join(' ')}`;
            if (path.endsWith('/environ')) {
                if (enrichmentLost.has(pid)) throw Object.assign(new Error('process enrichment unavailable'), { code: 'EACCES' });
                return pid === process.pid ? '' : `HAPPIER_PROCESS_OWNER=v1.${scope}.session.${owner.sessionId}\0`;
            }
            return '';
        },
    } };
    const root: HappierProcessRoot = { owner, pid: 4100, start: { startTimeMs: 1000 }, live: true,
        ownerCreatedAtMs: 0, ownerCreatedStartTimeMs: 1000 };
    let roots: readonly HappierProcessRoot[] = [root];
    const runtime = createProcessOwnershipRuntime({ platform: 'linux', daemonScopeKey: scope,
        censusDependencies, listRoots: () => roots });
    const signals: number[] = [];
    const remainder = createEndOwnerRemainder({ platform: 'linux', processOwnershipRuntime: runtime, daemonScopeKey: scope,
        firstPass: () => {}, systemBoundary: { platform: 'linux', censusDependencies,
            ...(stateAfterSignal === 'exits_during_grace' ? { wait: async () => { rows.delete(4102); } } : {}),
            kill(pid) {
                signals.push(pid);
                if (pid === 4102) {
                    rows.set(pid, { ...rows.get(pid)!, parent: 1, state: stateAfterSignal === 'exits_during_grace' ? 'S' : stateAfterSignal });
                    enrichmentLost.add(pid);
                } else rows.delete(pid);
                return true;
            },
        } });
    const captured = await remainder.capture(owner);
    roots = [{ ...root, live: false }];
    rows.delete(root.pid);
    const result = await remainder.end(owner, captured);
    if (stateAfterSignal !== 'S') {
        expect(result).toMatchObject({ status: 'complete', outcomes: [
            { pid: 4101, outcome: 'ended' }, { pid: 4102, outcome: 'ended' },
        ] });
    } else {
        expect(result).toMatchObject({ status: 'incomplete', outcomes: expect.arrayContaining([
            { pid: 4102, outcome: 'refused', reason: 'containment_authority_changed' },
        ]) });
    }
    expect(signals.sort()).toEqual([4101, 4102]);
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
