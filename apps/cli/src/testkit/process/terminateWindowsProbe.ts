/** Development-only native Windows owner/termination composition probe. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readProcessCensus, type ProcessCensusRow } from '@/processes/census/processCensus';
import { formatProcessOwnerTag, resolveProcessOwnerScopeKey } from '@/processes/ownerTag';
import { terminateProcessTree } from '@/processes/terminate/terminateProcessTree';
import { createFiniteProcessCustodyInvocation, createProcessCustodyHandshakePath, createWindowsJobCustodyName, queryProcessCustodyJob, resolveProcessCustodySupportExecutable } from '@/subprocess/supervision/processCustody';
import { spawnSupervisedPluginProcess, waitForSupervisedPluginProcessCustody } from '@/plugins/runtime/exec/processSupervisor';
import { createProcessOwnershipRuntime } from '@/daemon/processes/ownership/processOwnershipRuntime';
import { createEndOwnerRemainder } from '@/daemon/processes/endOwnerRemainder';
import type { HappierProcessRoot, ProcessOwnerRef } from '@/daemon/processes/ownership/types';

async function census() {
    const snapshot = await readProcessCensus({ freshness: 'fresh' });
    assert.equal(snapshot.status, 'ok', JSON.stringify(snapshot));
    if (snapshot.status !== 'ok') throw new Error('Native census unavailable');
    return snapshot;
}

async function startHolder(executable: string, tag: string, jobName: string) {
    const holder = spawn(executable, ['-test.run=^TestOwnerHeldJobSubprocess$', '--', 'holder', jobName], {
        env: { ...process.env, HAPPIER_PROCESS_OWNER: tag }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '';
    let errors = '';
    holder.stderr?.on('data', chunk => { errors += String(chunk); });
    try {
        const childPid = await new Promise<number>((resolve, reject) => {
            // A fixture startup deadline, not a runtime termination policy.
            const timer = setTimeout(() => reject(new Error(`Holder startup timed out: ${output} ${errors}`)), 15_000);
            const done = (error?: Error, pid?: number) => {
                clearTimeout(timer);
                if (error) reject(error);
                else if (pid) resolve(pid);
            };
            holder.once('error', error => done(error));
            holder.once('exit', (code, signal) => done(new Error(`Holder exited before readiness: ${code}/${signal} ${errors}`)));
            holder.stdout?.on('data', chunk => {
                output += String(chunk);
                const pidLine = output.split(/\r?\n/u).find(line => /^[1-9][0-9]*$/u.test(line));
                if (output.includes('holder-joined') && pidLine) done(undefined, Number(pidLine));
            });
        });
        assert.ok(holder.pid);
        return { holder, childPid };
    } catch (error) {
        holder.kill('SIGKILL');
        throw error;
    }
}

async function cleanup(holder: ChildProcess, childPid: number) {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
    const snapshot = await census();
    const targets = snapshot.rows.filter(row => row.pid === holder.pid || row.pid === childPid)
        .map(row => ({ pid: row.pid, start: row.start }));
    if (targets.length) await terminateProcessTree({ targets, tree: false, firstSignal: 'SIGKILL' });
    const after = await census();
    assert.ok(!after.rows.some(row => row.pid === holder.pid || row.pid === childPid), 'Probe cleanup must not leave owned fixture processes');
    console.log(JSON.stringify({ phase: 'fixture-cleanup', holderPid: holder.pid, childPid, result: 'absent' }));
}

async function runScenario(executable: string, home: string, helper: string, abrupt: boolean) {
    const owner: ProcessOwnerRef = { kind: 'session', sessionId: `native-win-${process.pid}-${abrupt ? 'abrupt' : 'normal'}` };
    const tag = formatProcessOwnerTag({ happierHomeDir: home, owner });
    const jobName = createWindowsJobCustodyName(tag);
    const { holder, childPid } = await startHolder(executable, tag, jobName);
    try {
        const initial = await census();
        const holderRow = initial.rows.find(row => row.pid === holder.pid);
        const member = initial.rows.find(row => row.pid === childPid);
        assert.ok(holderRow, 'Native census must include the holder');
        assert.ok(member, 'Native census must include the member');
        assert.equal(member.ownerTag, tag);
        assert.ok(member.jobs?.includes(jobName), 'Native census must recover holder-backed Job membership');
        assert.equal(await queryProcessCustodyJob({ executablePath: helper, jobName }), 'live');
        console.log(JSON.stringify({ phase: 'live-holder-native-proof', scenario: abrupt ? 'abrupt' : 'normal',
            helper, tag, jobName, holderPid: holderRow.pid, holderStart: holderRow.start,
            childPid, childStart: member.start, memberJobs: member.jobs }));
        let live = true;
        const root: HappierProcessRoot = {
            owner, pid: holderRow.pid, start: holderRow.start, live, ownerCreatedAtMs: holderRow.start.startTimeMs,
            containment: { kind: 'windows_job', name: jobName },
        };
        const scope = resolveProcessOwnerScopeKey(home);
        const runtime = createProcessOwnershipRuntime({
            listRoots: () => [{ ...root, live }], daemonScopeKey: scope, platform: 'win32',
        });
        let observed = false;
        const remainder = createEndOwnerRemainder({
            processOwnershipRuntime: runtime, daemonScopeKey: scope, platform: 'win32',
            firstPass: () => { observed = true; },
        });
        const captured = await remainder.capture(owner);
        assert.ok(captured && captured.ownership.some(row => row.pid === childPid && row.level === 'proven'));
        console.log(JSON.stringify({ phase: 'captured-native-owned-rows', rows: captured.ownership.map(row => {
            const native = initial.rows.find(candidate => candidate.pid === row.pid);
            return { pid: row.pid, start: row.start, level: row.level, chain: row.chain, evidence: row.evidence,
                name: native?.name, ppid: native?.ppid, executablePath: native?.executablePath,
                ownerTag: native?.ownerTag, jobs: native?.jobs };
        }) }));
        let outcomes: unknown;
        let survivingMember: ProcessCensusRow | undefined;
        if (abrupt) {
            const exited = once(holder, 'exit');
            assert.equal(holder.kill('SIGKILL'), true);
            await exited;
            live = false;
            assert.equal(await queryProcessCustodyJob({ executablePath: helper, jobName }), 'absent');
            const fresh = await runtime.readOwners({ freshness: 'fresh' });
            assert.equal(fresh.status, 'ok');
            if (fresh.status !== 'ok') throw new Error('Native ownership unavailable');
            survivingMember = fresh.snapshot.rows.find(row => row.pid === childPid);
            assert.ok(survivingMember, 'Member must survive loss of the holder-backed Job');
            assert.equal(survivingMember.ownerTag, tag);
            assert.ok(!survivingMember.jobs?.includes(jobName));
            console.log(JSON.stringify({ phase: 'lost-holder-native-proof', holderPid: holderRow.pid,
                childPid, childStart: survivingMember.start, ownerTag: survivingMember.ownerTag, jobs: survivingMember.jobs }));
            assert.ok(fresh.rows.some(row => row.pid === childPid && row.ownerEnded
                && row.level === 'left_behind' && row.evidence.some(evidence => evidence.kind === 'marker' && evidence.state === 'met')),
            'Fresh native marker plus the known ended root must classify the surviving member');
            console.log(JSON.stringify({ phase: 'fresh-native-ended-owner-rows', rows: fresh.rows.filter(row =>
                row.owner?.kind === 'session' && row.owner.sessionId === owner.sessionId).map(row => {
                const native = fresh.snapshot.rows.find(candidate => candidate.pid === row.pid);
                return { pid: row.pid, start: row.start, level: row.level, chain: row.chain, evidence: row.evidence,
                    name: native?.name, ppid: native?.ppid, executablePath: native?.executablePath,
                    ownerTag: native?.ownerTag, jobs: native?.jobs };
            }) }));
            const result = await remainder.end(owner, captured);
            assert.equal(result.status, 'complete', JSON.stringify(result));
            assert.equal(observed, true);
            outcomes = result.outcomes;
        } else {
            const result = await terminateProcessTree({ targets: [{ pid: holderRow.pid, start: holderRow.start }], tree: true });
            assert.ok(result.outcomes.every(row => row.outcome !== 'refused' && row.outcome !== 'survived'), JSON.stringify(result));
            outcomes = result.outcomes;
        }
        const after = await census();
        assert.ok(!after.rows.some(row => row.pid === holderRow.pid || row.pid === childPid), 'Shared terminator must end both owned fixture processes');
        assert.equal(await queryProcessCustodyJob({ executablePath: helper, jobName }), 'absent');
        console.log(JSON.stringify({ scenario: abrupt ? 'holder-lost-marker-remainder' : 'holder-live-tree-stop',
            helper, jobName, tag, holderPid: holderRow.pid, holderStart: holderRow.start,
            childPid, childStart: member.start, survivingMember: survivingMember && { start: survivingMember.start, ownerTag: survivingMember.ownerTag, jobs: survivingMember.jobs },
            outcomes, final: 'holder-and-member-absent' }));
    } finally {
        await cleanup(holder, childPid);
    }
}

async function runLegacySupervisor(helper: string) {
    const custody = { jobName: createWindowsJobCustodyName(`native-supervisor-${process.pid}`), executablePath: helper,
        handshakePath: createProcessCustodyHandshakePath() };
    const invocation = createFiniteProcessCustodyInvocation({ custody, command: process.execPath,
        args: ['-e', 'const{spawn}=require("node:child_process");const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});c.unref();console.log(c.pid);setInterval(()=>{},1000)'] });
    const supervised = spawnSupervisedPluginProcess({ command: invocation.command, args: invocation.args,
        env: { ...process.env }, processCustody: custody });
    const descendantReady = new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Legacy fixture descendant did not become ready')), 15_000);
        let output = '';
        supervised.child.stdout.on('data', chunk => {
            output += String(chunk);
            const pid = output.split(/\r?\n/u).find(line => /^[1-9][0-9]*$/u.test(line));
            if (pid) { clearTimeout(timer); resolve(Number(pid)); }
        });
    });
    void descendantReady.catch(() => undefined);
    const captured: ProcessCensusRow[] = [];
    try {
        const joined = await waitForSupervisedPluginProcessCustody({ custody });
        assert.ok(joined, 'Actual legacy supervisor custody must complete its native handshake');
        const descendantPid = await descendantReady;
        const before = await readProcessCensus({ freshness: 'fresh', scope: 'all', verifiedJobNames: [custody.jobName] });
        assert.equal(before.status, 'ok');
        if (before.status !== 'ok') throw new Error('Explicit legacy Job census unavailable');
        const job = before.jobObservations?.find(job => job.name === custody.jobName);
        assert.equal(job?.state, 'live');
        if (job?.state !== 'live') throw new Error('Legacy Job not live');
        captured.push(...before.rows.filter(row => job.pids.includes(row.pid)));
        assert.ok(captured.some(row => row.pid === joined.targetPid));
        assert.ok(captured.some(row => row.pid === descendantPid), 'Explicit Job census must include the real descendant');
        console.log(JSON.stringify({ phase: 'legacy-supervisor-native-members', jobName: custody.jobName,
            helperPid: supervised.child.pid, targetPid: joined.targetPid, members: captured.map(row => ({ pid: row.pid, start: row.start, jobs: row.jobs })) }));
        await supervised.dispose('hostShutdown');
        await supervised.waitForSettlement();
        const after = await readProcessCensus({ freshness: 'fresh', scope: 'all', verifiedJobNames: [custody.jobName] });
        assert.equal(after.status, 'ok');
        if (after.status !== 'ok') throw new Error('Explicit legacy Job verification unavailable');
        assert.equal(after.jobObservations?.find(job => job.name === custody.jobName)?.state, 'absent');
        assert.ok(!after.rows.some(row => captured.some(member => member.pid === row.pid && member.start.startTimeMs === row.start.startTimeMs)));
        console.log(JSON.stringify({ scenario: 'legacy-supervisor-single-terminator', jobName: custody.jobName,
            members: captured.map(row => ({ pid: row.pid, start: row.start })), final: 'job-and-members-absent' }));
    } finally {
        if (supervised.child.exitCode === null && supervised.child.signalCode === null) supervised.child.kill('SIGKILL');
        if (captured.length) await terminateProcessTree({ targets: captured.map(row => ({ pid: row.pid, start: row.start })), tree: false, firstSignal: 'SIGKILL' });
    }
}

assert.equal(process.platform, 'win32', 'Run with native Windows Node, not WSL Node');
const home = process.env.HAPPIER_HOME_DIR;
assert.ok(home, 'A dedicated Happier home must be set before Node starts');
const executable = process.argv[2];
assert.ok(executable, 'Supply the owner-held native fixture executable');
const helper = resolveProcessCustodySupportExecutable();
assert.ok(helper, 'Stage the current native helper beside this developer probe');
const scenario = process.argv[3] ?? 'both';
assert.ok(['both', 'normal', 'abrupt', 'legacy'].includes(scenario));
if (scenario === 'both' || scenario === 'normal') await runScenario(executable, home, helper, false);
if (scenario === 'both' || scenario === 'abrupt') await runScenario(executable, home, helper, true);
if (scenario === 'both' || scenario === 'legacy') await runLegacySupervisor(helper);
console.log(JSON.stringify({ result: 'PASS', scenario, platform: process.platform, nativeNode: process.execPath, home }));
