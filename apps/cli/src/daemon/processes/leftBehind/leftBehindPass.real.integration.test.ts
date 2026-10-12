import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';
import { createTestTempDirectory } from '../../../../../../scripts/testing/process/temporaryDirectories.mjs';

import { readProcessCensus, type ProcessStartIdentity } from '@/processes/census/processCensus';
import { formatProcessOwnerTag, PROCESS_OWNER_ENV_KEY, resolveProcessOwnerScopeKey } from '@/processes/ownerTag';
import { terminateProcessTree } from '@/processes/terminate/terminateProcessTree';
import { resolveProcessCustodySupportExecutable } from '@/subprocess/supervision/processCustody';
import { spawnInlineNodeTestProcess, waitForProcessExit } from '@/testkit/process/spawn';
import { createProcessOwnershipRuntime } from '../ownership/processOwnershipRuntime';
import { listHappierProcessRoots } from '../roots/listHappierProcessRoots';
import { createLeftBehindPass } from './leftBehindPass';
import { LEFT_BEHIND_CONFIRMATION_INTERVAL_MS } from './leftBehindTracker';

let runner: ChildProcess | undefined;
let cleanupTargets: Array<{ pid: number; start?: ProcessStartIdentity }> = [];
let pass: ReturnType<typeof createLeftBehindPass> | undefined;
let home: ReturnType<typeof createTestTempDirectory> | undefined;

afterEach(async () => {
    pass?.dispose();
    pass = undefined;
    if (cleanupTargets.length) await terminateProcessTree({ targets: cleanupTargets, tree: true, graceMs: 300 });
    await Promise.all(cleanupTargets.map(target => waitForProcessExit(target.pid)));
    cleanupTargets = [];
    runner = undefined;
    home?.cleanup();
    home = undefined;
});

async function spawnTaggedRunner(ownerTag: string): Promise<number> {
    const childSource = 'console.log(String(process.pid)); setInterval(() => {}, 1000);';
    runner = spawnInlineNodeTestProcess([
        'const { spawn } = require("node:child_process");',
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(childSource)}], {detached:true,stdio:["ignore","pipe","ignore"]});`,
        'child.stdout.pipe(process.stdout);',
        'setInterval(() => {}, 1000);',
    ].join('\n'), { env: { ...process.env, [PROCESS_OWNER_ENV_KEY]: ownerTag }, stdio: ['ignore', 'pipe', 'pipe'] });
    if (!runner.pid || !runner.stdout) throw new Error('tagged runner did not spawn');
    cleanupTargets = [{ pid: runner.pid }];
    const output = runner.stdout;
    const childPid = await new Promise<number>((resolve, reject) => {
        let buffer = '';
        const timer = setTimeout(() => { cleanup(); reject(new Error('tagged child did not report readiness')); }, 10000);
        const cleanup = () => { clearTimeout(timer); output.off('data', onData); runner?.off('error', onError); };
        const onError = (error: Error) => { cleanup(); reject(error); };
        const onData = (chunk: Buffer) => {
            buffer += chunk.toString();
            const line = buffer.split('\n')[0];
            if (!buffer.includes('\n')) return;
            const pid = Number(line);
            cleanup();
            if (!Number.isSafeInteger(pid) || pid <= 1) reject(new Error('invalid tagged child pid'));
            else resolve(pid);
        };
        output.on('data', onData);
        runner?.on('error', onError);
    });
    cleanupTargets.push({ pid: childPid });
    return childPid;
}

describe.skipIf(process.platform === 'win32')('daemon-start detection of a real marker orphan', () => {
    it('confirms the surviving tagged child twice a minute apart and ends that exact generation', async () => {
        home = createTestTempDirectory('happier-marker-orphan-');
        const happierHomeDir = home.root;
        const owner = { kind: 'session', sessionId: randomUUID() } as const;
        const ownerTag = formatProcessOwnerTag({ happierHomeDir, owner });
        const childPid = await spawnTaggedRunner(ownerTag);
        const runnerPid = runner?.pid;
        if (!runnerPid) throw new Error('runner pid unavailable');
        const before = await readProcessCensus({ freshness: 'fresh', pids: [runnerPid, childPid] });
        if (before.status !== 'ok') throw new Error(`fixture census unavailable: ${before.reason}`);
        const runnerRow = before.rows.find(row => row.pid === runnerPid);
        const childRow = before.rows.find(row => row.pid === childPid);
        if (!runnerRow || !childRow) throw new Error('fixture census lost a live process');
        expect(runnerRow.ownerTag).toBe(ownerTag);
        expect(childRow.ownerTag).toBe(ownerTag);
        expect(childRow.ppid).toBe(runnerPid);
        cleanupTargets = [runnerRow, childRow].map(({ pid, start }) => ({ pid, start }));

        // No custody reader exists while the runner dies: this is the daemon-down window.
        runner?.kill('SIGKILL');
        expect(await waitForProcessExit(runnerPid)).toBe(true);
        const orphan = await readProcessCensus({ freshness: 'fresh', pids: [childPid] });
        if (orphan.status !== 'ok') throw new Error('orphan census unavailable');
        expect(orphan.rows.find(row => row.pid === childPid)).toMatchObject({ start: childRow.start, ownerTag });
        const endedAtMs = Date.now();
        const ownership = createProcessOwnershipRuntime({
            daemonScopeKey: resolveProcessOwnerScopeKey(happierHomeDir),
            listRoots: snapshot => listHappierProcessRoots({
                snapshot, happierHomeDir,
                endedRoots: [{
                    owner, pid: runnerPid, start: runnerRow.start, live: false, endedAtMs,
                    ownerCreatedAtMs: process.platform === 'linux' ? before.capturedAtMs : runnerRow.start.startTimeMs,
                    ownerCreatedStartTimeMs: runnerRow.start.startTimeMs,
                }],
            }),
        });
        pass = createLeftBehindPass({ processOwnershipRuntime: ownership });
        const observed = await ownership.readOwners({ freshness: 'fresh' });
        if (observed.status !== 'ok') throw new Error('ownership census unavailable');
        expect(observed.rows.find(row => row.pid === childPid)).toMatchObject({ owner, ownerEnded: true, level: 'left_behind' });
        await pass.firstPass();
        expect(pass.confirmed()).toEqual([]);
        await new Promise(resolve => setTimeout(resolve, LEFT_BEHIND_CONFIRMATION_INTERVAL_MS));
        const confirmation = await pass.readConfirmed();
        if (confirmation.status !== 'ok') throw new Error(`confirmation census unavailable: ${confirmation.reason}`);
        const confirmed = confirmation.items;
        expect(confirmed).toHaveLength(1);
        expect(confirmed[0]).toMatchObject({ pid: childPid, start: childRow.start, owner });
        expect(confirmed[0]!.confirmedAtMs - confirmed[0]!.firstSeenAtMs).toBeGreaterThanOrEqual(LEFT_BEHIND_CONFIRMATION_INTERVAL_MS);

        const result = await terminateProcessTree({ targets: confirmed.map(({ pid, start }) => ({ pid, start })), tree: true, graceMs: 300 });
        expect(result.outcomes).toContainEqual(expect.objectContaining({ pid: childPid, outcome: 'ended' }));
        expect(await waitForProcessExit(childPid)).toBe(true);
        console.info('[left-behind-real]', JSON.stringify({
            platform: process.platform, helper: resolveProcessCustodySupportExecutable(process.platform),
            runner: { pid: runnerPid, start: runnerRow.start }, child: { pid: childPid, start: childRow.start },
            firstSeenAtMs: confirmed[0]!.firstSeenAtMs, confirmedAtMs: confirmed[0]!.confirmedAtMs,
            markerVerified: true, outcome: 'ended',
        }));
    }, LEFT_BEHIND_CONFIRMATION_INTERVAL_MS + 60000);
});
