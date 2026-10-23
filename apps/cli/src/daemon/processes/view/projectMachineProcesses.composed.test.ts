import { expect, it } from 'vitest';
import { MachineProcessesAnswerV1Schema } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import type { ProcessCensusSnapshot } from '@/processes/census/processCensus';
import { listHappierProcessRoots } from '../roots/listHappierProcessRoots';
import { resolveProcessOwnership } from '../ownership/resolveProcessOwnership';
import { projectMachineProcesses } from './projectMachineProcesses';
import { processRef } from './processRef';
import { buildMachineProcessesView } from '../../../../../ui/sources/components/machines/processes/processesPresentation';

it('carries the native Session root through the compact wire answer into the widget Action target', () => {
    // The OS census is the system boundary. Root identity, ownership, strict wire admission,
    // and the UI presentation model all run through their production owners.
    const snapshot: Extract<ProcessCensusSnapshot, { status: 'ok' }> = {
        status: 'ok', capturedAtMs: 100_000, logicalCpus: 4,
        rows: [{ pid: 10, ppid: 1 }, { pid: 20, ppid: 1 }, { pid: 21, ppid: 20 }].map(row => ({
            ...row, name: 'happier', start: { startTimeMs: row.pid, native: `linux-proc:${row.pid}` },
            principal: { kind: 'uid', value: '1' }, memory: { bytes: row.pid, kind: 'rss' }, cpuTimeUs: 0,
        })),
    };
    const roots = listHappierProcessRoots({ snapshot, selfPid: 10, platform: 'linux', bootTimeMs: 1000,
        daemonScopeKey: '123456789abc', trackedSessions: [{ pid: 20, processStartTimeMs: 20, happySessionId: 'owner-session' }] });
    const rows = resolveProcessOwnership({ snapshot, roots, daemonPrincipal: snapshot.rows[0].principal,
        daemonScopeKey: '123456789abc', platform: 'linux' });
    const answer = MachineProcessesAnswerV1Schema.parse(projectMachineProcesses({ status: 'ok', snapshot, roots, rows },
        { machineId: 'machine', scope: 'happier', view: 'owners' }, { accountId: 'owner', custodianAccountId: 'owner' },
        { platform: 'linux', selfPid: 10, allProcessesVisible: false, confirmed: [], bootTimeMs: 1000,
            requesterForOwner: () => ({ accountId: 'owner', displayName: 'Owner' }) }));
    const rootRef = processRef(20, snapshot.rows[1].start);
    expect(answer.owners.find(row => row.rowId === 'session:owner-session')).toMatchObject({
        root: { ref: rootRef, level: 'proven' }, canStartAgain: true, members: [],
        totals: { processCount: 2, memoryBytes: 41 },
    });
    const view = buildMachineProcessesView({ answer, scope: 'happier', ownersOnly: true,
        sort: { key: 'memory', direction: 'descending' } });
    expect(view.items.find(row => row.key === 'o:session:owner-session')).toMatchObject({ rootRef, rootLevel: 'proven' });
});
