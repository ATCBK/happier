import { describe, expect, it } from 'vitest';
import { MachineProcessesAnswerV1Schema } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import type { ProcessCensusSnapshot } from '@/processes/census/processCensus';
import { resolveProcessOwnership } from '../ownership/resolveProcessOwnership';
import { createLeftBehindTracker } from '../leftBehind/leftBehindTracker';
import { projectMachineProcesses, type ProcessesProjectionOptions, type ProcessRequesterEvidenceFailure } from './projectMachineProcesses';
import { processRef } from './processRef';
import { processOwnerKey } from '../ownership/types';
import { createProcessMetrics } from './processMetrics';

const scope = '123456789abc';

it('classifies a language-server service by its owner even when its binary is tsc', () => {
    const read = setup();
    const snapshot = { ...read.snapshot, rows: read.snapshot.rows.map(row => row.pid === 21
        ? { ...row, name: 'tsc', argv: ['tsc', '--lsp', '--stdio'] } : row) };
    const roots = [...read.roots, { owner: { kind: 'service' as const, serviceId: 'lsp:example.typescript:0123456789ab' },
        pid: 21, start: snapshot.rows.find(row => row.pid === 21)!.start, live: true, ownerCreatedAtMs: 0, ownerCreatedStartTimeMs: 0 }];
    const current = { ...read, snapshot, roots, rows: resolveProcessOwnership({ snapshot, roots,
        daemonPrincipal: snapshot.rows[0].principal, daemonScopeKey: scope, platform: 'linux' }) };
    const answer = projectMachineProcesses(current, request, { accountId: 'owner', custodianAccountId: 'owner' }, options);
    expect(answer.owners.flatMap(owner => owner.members).find(row => row.pid === 21)).toMatchObject({ role: 'language_server' });
    expect(MachineProcessesAnswerV1Schema.safeParse(answer).success).toBe(true);

    const compiler = { ...current, roots: read.roots, rows: resolveProcessOwnership({ snapshot, roots: read.roots,
        daemonPrincipal: snapshot.rows[0].principal, daemonScopeKey: scope, platform: 'linux' }) };
    expect(projectMachineProcesses(compiler, request, { accountId: 'owner', custodianAccountId: 'owner' }, options)
        .owners.flatMap(owner => owner.members).find(row => row.pid === 21)).toMatchObject({ role: 'type_checker' });
});

it('offers Start again only for the exact live root with a retained start owner', () => {
    const read = setup();
    const owner = { kind: 'service' as const, serviceId: 'lsp:fixture:0123456789ab' };
    const root = { owner, pid: 21, start: read.snapshot.rows.find(row => row.pid === 21)!.start,
        live: true, ownerCreatedAtMs: 0, ownerCreatedStartTimeMs: 0 };
    for (const restartable of [false, true]) {
        const roots = [...read.roots, { ...root, ...(restartable ? { startAgain: async () => ({ status: 'started' as const }) } : {}) }];
        const current = { ...read, roots, rows: resolveProcessOwnership({ snapshot: read.snapshot, roots,
            daemonPrincipal: read.snapshot.rows[0].principal, daemonScopeKey: scope, platform: 'linux' }) };
        const answer = projectMachineProcesses(current, request, { accountId: 'owner', custodianAccountId: 'owner' }, options);
        expect(answer.owners.find(row => row.owner.kind === 'service')).toHaveProperty('canStartAgain', restartable);
        expect(MachineProcessesAnswerV1Schema.safeParse(answer).success).toBe(true);
    }
});

it('offers the next-message way back for a live Session without a service restart callback', () => {
    const read = setup();
    const answer = projectMachineProcesses(read, request, { accountId: 'owner', custodianAccountId: 'owner' }, options);
    expect(answer.owners.find(row => row.owner.kind === 'session' && row.owner.sessionId === 'owner-session'))
        .toHaveProperty('canStartAgain', true);
    expect(answer.owners.find(row => row.owner.kind === 'happier')).toHaveProperty('canStartAgain', false);
    expect(MachineProcessesAnswerV1Schema.safeParse(answer).success).toBe(true);
});

it('preserves existing tool and catalog display names beside native identity without enriching external rows', () => {
    const read = setup();
    const snapshot = { ...read.snapshot, rows: [
        ...read.snapshot.rows.map(row => row.pid === 21 ? { ...row, name: 'node' } : row),
        ...[
            { pid: 60, argv: ['node', '/tools/catalog-agent', '--token', 'agent-secret'] },
            { pid: 61, argv: ['python', '/tools/catalog-mcp', '--password', 'mcp-secret'] },
            { pid: 62, argv: ['python', '-m', 'http.server'] },
            { pid: 63, argv: ['python', '-c', 'print("inline-private")'] },
        ].map(row => ({ ...read.snapshot.rows[0], ...row, ppid: 20, name: row.argv[0], start: { startTimeMs: row.pid } })),
    ] };
    const current = { ...read, snapshot, rows: resolveProcessOwnership({ snapshot, roots: read.roots,
        daemonPrincipal: snapshot.rows[0].principal, daemonScopeKey: scope, platform: 'linux' }) };
    const answer = projectMachineProcesses(current, { ...request, scope: 'all' }, { accountId: 'owner', custodianAccountId: 'owner' }, {
        ...options, roleCatalog: { agentExecutables: [{ executable: 'catalog-agent', name: 'Catalog Agent' }],
            mcpServers: [{ executable: 'catalog-mcp', name: 'Catalog MCP' }] },
    });
    const members = answer.owners.flatMap(owner => owner.members);
    expect(members.find(row => row.pid === 21)).toMatchObject({ name: 'node', role: 'dev_server', displayName: 'Vite',
        ref: processRef(21, snapshot.rows.find(row => row.pid === 21)!.start) });
    expect(members.find(row => row.pid === 60)).toMatchObject({ name: 'node', role: 'agent', displayName: 'Catalog Agent' });
    expect(members.find(row => row.pid === 61)).toMatchObject({ name: 'python', role: 'mcp_server', displayName: 'Catalog MCP' });
    expect(members.find(row => row.pid === 62)).toMatchObject({ name: 'python', displayName: 'Python HTTP server' });
    expect(members.find(row => row.pid === 63)).not.toHaveProperty('displayName');
    expect(answer.notHappier?.flatMap(group => group.members)).toEqual([{ name: 'unrelated', appGroup: 'unrelated', pid: 40,
        ref: processRef(40, snapshot.rows.find(row => row.pid === 40)!.start), memoryBytes: 40 }]);
    expect(JSON.stringify(answer)).not.toMatch(/agent-secret|mcp-secret|secret with spaces|secret argument|\/private\/unrelated/);
    expect(MachineProcessesAnswerV1Schema.safeParse(answer).success).toBe(true);
});

describe('browser process projection', () => {
    it('groups a browser main and helpers with exact refs and deduped totals beneath its real driver', () => {
        const read = setup();
        const extra = [
            { pid: 60, ppid: 20, argv: ['node', 'playwright', 'test', '--project=chromium'] },
            { pid: 61, ppid: 60, argv: ['chromium'] },
            { pid: 62, ppid: 61, argv: ['chromium', '--type=renderer'] },
            { pid: 63, ppid: 62, argv: ['chromium', '--type=utility'] },
            { pid: 64, ppid: 60, argv: ['chromium'] },
            { pid: 65, ppid: 64, argv: ['chromium', '--type=renderer'] },
        ].map(row => ({ ...read.snapshot.rows[0], ...row, name: row.argv[0], start: { startTimeMs: row.pid } }));
        const snapshot = { ...read.snapshot, rows: [...read.snapshot.rows, ...extra] };
        const current = { ...read, snapshot, rows: resolveProcessOwnership({ snapshot, roots: read.roots,
            daemonPrincipal: snapshot.rows[0].principal, daemonScopeKey: scope, platform: 'linux' }) };
        const answer = projectMachineProcesses(current, request, { accountId: 'owner', custodianAccountId: 'owner' }, options);
        const members = answer.owners.find(owner => owner.rowId === 'session:owner-session')!.members;
        const main = members.find(row => row.pid === 61)!;
        expect(members.find(row => row.pid === 60)).toMatchObject({ role: 'test_runner' });
        expect(members.find(row => row.pid === 60)).not.toHaveProperty('browserEngine');
        expect(main).toMatchObject({ browserEngine: 'chromium', browserHelper: false, driverLabel: 'node playwright test --project=chromium',
            parentRowId: processRef(60, { startTimeMs: 60 }),
            browserGroup: { memberRefs: [61, 62, 63].map(pid => processRef(pid, { startTimeMs: pid })),
                totals: { processCount: 3, memoryBytes: 30 } } });
        expect(members.find(row => row.pid === 63)).toMatchObject({ browserHelper: true, parentRowId: main.rowId,
            ref: processRef(63, { startTimeMs: 63 }), memoryBytes: 10 });
        expect(members.find(row => row.pid === 64)).toMatchObject({ browserGroup: { totals: { processCount: 2, memoryBytes: 20 } } });
        expect(answer.owners.find(owner => owner.rowId === 'session:owner-session')!.totals).toMatchObject({ processCount: 8, memoryBytes: 101 });
        expect(answer.totals.happier).toMatchObject({ processCount: 11, memoryBytes: 172 });
        expect(MachineProcessesAnswerV1Schema.safeParse(answer).success).toBe(true);
        const detail = projectMachineProcesses(current, { ...request, detailToken: processRef(63, { startTimeMs: 63 }) },
            { accountId: 'owner', custodianAccountId: 'owner' }, options);
        expect(detail.owners.flatMap(owner => owner.members).find(row => row.pid === 63)?.evidence).toHaveLength(4);
        expect(projectMachineProcesses(current, request, { accountId: 'guest', custodianAccountId: 'owner' }, options)
            .owners.flatMap(owner => owner.members).some(row => row.browserEngine)).toBe(false);
        const filtered = projectMachineProcesses(current, { ...request, query: '--type=utility' },
            { accountId: 'owner', custodianAccountId: 'owner' }, options);
        expect(filtered.owners[0].members.map(row => row.pid)).toEqual([61, 63]);
        expect(filtered.owners[0].members[0].browserGroup).toMatchObject({
            memberRefs: [61, 63].map(pid => processRef(pid, { startTimeMs: pid })), totals: { processCount: 2, memoryBytes: 20 } });
        expect(filtered.totals.happier).toMatchObject({ processCount: 2, memoryBytes: 20 });
    });
});
function setup() {
    const snapshot: Extract<ProcessCensusSnapshot, { status: 'ok' }> = { status: 'ok', capturedAtMs: 100_000, logicalCpus: 4,
        rows: [
            { pid: 10, ppid: 1, name: 'happier' }, { pid: 20, ppid: 1, name: 'agent-owner' },
            { pid: 21, ppid: 20, name: 'vite', argv: ['node', 'vite', '--token', 'secret with spaces'], cwd: '/private/owner' },
            { pid: 30, ppid: 1, name: 'agent-guest' }, { pid: 31, ppid: 30, name: 'guest-secret', cwd: '/private/guest' },
            { pid: 40, ppid: 1, name: 'unrelated', argv: ['unrelated', 'secret argument'], cwd: '/private/unrelated' },
            { pid: 50, ppid: 1, name: 'other-user', principal: { kind: 'uid' as const, value: '2' }, argv: ['secret'] },
        ].map(row => ({ start: { startTimeMs: row.pid, native: `linux-proc:${row.pid}` },
            principal: { kind: 'uid', value: '1' }, memory: { bytes: row.pid, kind: 'rss' }, cpuTimeUs: 0, ...row })) };
    const roots = [
        { owner: { kind: 'happier' as const }, pid: 10 },
        { owner: { kind: 'session' as const, sessionId: 'owner-session' }, pid: 20 },
        { owner: { kind: 'session' as const, sessionId: 'guest-session' }, pid: 30 },
    ].map(root => ({ ...root, start: snapshot.rows.find(row => row.pid === root.pid)!.start, live: true, ownerCreatedAtMs: 0, ownerCreatedStartTimeMs: 0 }));
    const rows = resolveProcessOwnership({ snapshot, roots, daemonPrincipal: snapshot.rows[0].principal, daemonScopeKey: scope, platform: 'linux' });
    return { status: 'ok' as const, snapshot, roots, rows };
}
const options: ProcessesProjectionOptions = { platform: 'linux', selfPid: 10, allProcessesVisible: true, confirmed: [], bootTimeMs: 1000,
    requesterForOwner: owner => ({ accountId: owner.kind === 'session' && owner.sessionId === 'guest-session' ? 'guest' : 'owner', displayName: 'Identity' }) };
const request = { machineId: 'm', scope: 'happier' as const, view: 'tree' as const };
function metricOwners(read: ReturnType<typeof setup>) {
    const owners = new Map<string, Map<number, string>>();
    for (const row of read.rows) if (row.owner && row.level !== 'left_behind') {
        const key = processOwnerKey(row.owner); const refs = owners.get(key) ?? new Map<number, string>();
        refs.set(row.pid, processRef(row.pid, row.start)); owners.set(key, refs);
    }
    return owners;
}
describe('process wire projection privacy', () => {
    it('counts ownerless unverifiable processes without exposing private fields or inventing ownership', () => {
        const read = setup();
        const snapshot = { ...read.snapshot, rows: [...read.snapshot.rows, { ...read.snapshot.rows[0], pid: 70, ppid: 1,
            start: { startTimeMs: 70 }, principal: null, name: 'private-unreadable', argv: ['private-command'], cwd: '/private/unknown' }] };
        const current = { ...read, snapshot, rows: resolveProcessOwnership({ snapshot, roots: read.roots,
            daemonPrincipal: snapshot.rows[0].principal, daemonScopeKey: scope, platform: 'linux' }) };
        const answer = projectMachineProcesses(current, request, { accountId: 'owner', custodianAccountId: 'owner' }, options);
        expect(answer).toHaveProperty('unverifiableCount', 1);
        expect(answer.totals.happier).toMatchObject({ processCount: 5 });
        expect(JSON.stringify(answer)).not.toMatch(/private-unreadable|private-command|\/private\/unknown/);
        expect(MachineProcessesAnswerV1Schema.safeParse(answer).success).toBe(true);
        expect(projectMachineProcesses(current, request, { accountId: 'guest', custodianAccountId: 'owner' }, options)).not.toHaveProperty('unverifiableCount');
    });
    it('gives a recipient only their rows, own totals and an owner count with no private guest or daemon facts', () => {
        const answer = projectMachineProcesses(setup(), request, { accountId: 'guest', custodianAccountId: 'owner' }, options);
        expect(answer.owners.map(row => row.owner)).toEqual([{ kind: 'session', sessionId: 'guest-session' }]);
        expect(answer.totals.happier).toMatchObject({ memoryBytes: 61, processCount: 2 });
        expect(answer.othersWork).toEqual({ count: 2 });
        expect(JSON.stringify(answer)).not.toContain('/private/owner');
        expect(answer).not.toHaveProperty('notHappier');
        expect(answer).not.toHaveProperty('otherPrincipals');
        expect(MachineProcessesAnswerV1Schema.safeParse(answer).success).toBe(true);
    });
    it('redacts Happier arguments and strips non-Happier detail at the daemon boundary, preserving honest first-tick CPU', () => {
        const answer = projectMachineProcesses(setup(), { ...request, scope: 'all' }, { accountId: 'owner', custodianAccountId: 'owner' }, options);
        expect(answer.owners.flatMap(owner => owner.members).find(row => row.pid === 21)?.command).toBe('node vite --token [REDACTED]');
        expect(answer.notHappier?.flatMap(group => group.members)).toEqual([{ name: 'unrelated', appGroup: 'unrelated', pid: 40,
            ref: processRef(40, { startTimeMs: 40, native: 'linux-proc:40' }), memoryBytes: 40 }]);
        expect(answer.otherPrincipals).toEqual({ count: 1, memoryBytes: 50, names: ['2'] });
        expect(answer.totals.happier).toEqual({ processCount: 5, memoryBytes: 112 });
        expect(MachineProcessesAnswerV1Schema.safeParse(answer).success).toBe(true);
        expect(projectMachineProcesses(setup(), { ...request, scope: 'all' }, { accountId: 'guest', custodianAccountId: 'owner' }, options).reason).toBe('permission_denied');
        expect(projectMachineProcesses(setup(), { ...request, scope: 'all' }, { accountId: 'owner', custodianAccountId: 'owner' }, { ...options, allProcessesVisible: false }).reason).toBe('all_processes_disabled');
    });
    it('shows only tracker-confirmed ended generations and never converts the live generic daemon tag to Left behind', () => {
        const read = setup();
        const ended = { ...read.roots[1], live: false, ownerCreatedStartTimeMs: 20, endedAtMs: 1000 };
        const snapshot = { ...read.snapshot, rows: read.snapshot.rows.filter(row => row.pid !== 20).map(row => row.pid === 21
            ? { ...row, ppid: 1, ownerTag: `v1.${scope}.session.owner-session` }
            : row.pid === 40 ? { ...row, ownerTag: `v1.${scope}.happier.daemon` } : row) };
        const roots = [read.roots[0], ended, read.roots[2]];
        const rows = resolveProcessOwnership({ snapshot, roots, daemonPrincipal: snapshot.rows[0].principal, daemonScopeKey: scope, platform: 'linux' });
        const tracker = createLeftBehindTracker();
        tracker.observe({ status: 'ok', capturedAtMs: snapshot.capturedAtMs, rows });
        const current = { status: 'ok' as const, snapshot, roots, rows };
        expect(projectMachineProcesses(current, request, { accountId: 'owner', custodianAccountId: 'owner' }, { ...options, confirmed: tracker.confirmed() }).leftBehind).toEqual([]);
        tracker.observe({ status: 'ok', capturedAtMs: snapshot.capturedAtMs + 60_000, rows });
        const answer = projectMachineProcesses(current, request, { accountId: 'owner', custodianAccountId: 'owner' }, { ...options, confirmed: tracker.confirmed() });
        expect(answer.leftBehind.map(row => row.pid)).toEqual([21]);
        expect(answer.owners.flatMap(owner => owner.members).find(row => row.pid === 40)?.level).toBe('proven');
        expect(answer.totals.leftBehind).toMatchObject({ processCount: 1, memoryBytes: 21 });
    });
    it('does not lend watched CPU to a recycled PID during a fresh read', () => {
        const answer = projectMachineProcesses(setup(), request, { accountId: 'owner', custodianAccountId: 'owner' }, { ...options,
            metrics: new Map([[21, { ref: 'previous-generation', memoryBytes: 21, cpuPercent: 80 }]]) });
        expect(answer.owners.flatMap(owner => owner.members).find(row => row.pid === 21)).not.toHaveProperty('cpuPercent');
        expect(answer.totals.happier).not.toHaveProperty('cpuPercent');
    });
    it('reports missing Linux boot-time evidence rather than presenting boot-relative starts as wall time', () => {
        expect(projectMachineProcesses(setup(), request, { accountId: 'owner', custodianAccountId: 'owner' }, { ...options, bootTimeMs: undefined }))
            .toMatchObject({ state: 'unavailable', reason: 'read_failed' });
    });
    it('projects current native owner stopping facts without creating a view-owned lifecycle', () => {
        const read = setup();
        const current = { ...read, roots: read.roots.map(root => root.pid === 20 ? { ...root, state: 'stopping' as const } : root) };
        const answer = projectMachineProcesses(current, request, { accountId: 'owner', custodianAccountId: 'owner' }, options);
        expect(answer.owners.find(owner => owner.rowId === 'session:owner-session')?.state).toBe('stopping');
        expect(answer.owners.find(owner => owner.rowId === 'session:guest-session')?.state).toBe('running');
    });
    it('does not present known guest work as custodian work when profile display evidence is unavailable', () => {
        const failures: ProcessRequesterEvidenceFailure[] = [];
        const withoutNames = { ...options, requesterForOwner: (owner: Parameters<ProcessesProjectionOptions['requesterForOwner']>[0]) =>
            ({ accountId: owner.kind === 'session' && owner.sessionId === 'guest-session' ? 'guest' : 'owner' }), requesterIdentities: new Map(),
            onRequesterEvidenceUnavailable: (failure: ProcessRequesterEvidenceFailure) => failures.push(failure) };
        expect(projectMachineProcesses(setup(), request, { accountId: 'owner', custodianAccountId: 'owner' }, withoutNames))
            .toMatchObject({ state: 'live', unverifiableCount: 2, owners: [
                expect.objectContaining({ owner: { kind: 'happier' } }),
                expect.objectContaining({ owner: { kind: 'session', sessionId: 'owner-session' } }),
            ] });
        expect(projectMachineProcesses(setup(), request, { accountId: 'guest', custodianAccountId: 'owner' }, withoutNames).owners)
            .toHaveLength(1);
        expect(failures).toEqual(expect.arrayContaining([
            { owner: { kind: 'session', sessionId: 'guest-session' }, reason: 'display_identity_unavailable' },
        ]));
        const hidden = projectMachineProcesses(setup(), { ...request, detailToken: processRef(31, { startTimeMs: 31, native: 'linux-proc:31' }) },
            { accountId: 'owner', custodianAccountId: 'owner' }, { ...withoutNames,
                history: ref => ref === processRef(31, { startTimeMs: 31, native: 'linux-proc:31' }) ? [{ capturedAtMs: 1000, memoryBytes: 31 }] : undefined });
        expect(JSON.stringify(hidden)).not.toMatch(/guest-secret|\/private\/guest|linux-proc:31/);
        failures.length = 0;
        expect(projectMachineProcesses(setup(), request, { accountId: 'owner', custodianAccountId: 'owner' },
            { ...withoutNames, requesterForOwner: () => null })).toMatchObject({ state: 'live', unverifiableCount: 5, owners: [],
                totals: { happier: { processCount: 0, memoryBytes: 0 } } });
        expect(failures).toEqual(expect.arrayContaining([{ owner: { kind: 'happier' }, reason: 'requester_unavailable' }]));
    });
    it('projects visible owner sparklines from watched members, while only opened process details get history', () => {
        const read = setup();
        const metrics = createProcessMetrics();
        metrics.observe(read.snapshot, 2000, metricOwners(read));
        metrics.observe({ ...read.snapshot, capturedAtMs: read.snapshot.capturedAtMs + 2000 }, 2000, metricOwners(read));
        const detail = processRef(21, read.snapshot.rows.find(row => row.pid === 21)!.start);
        const answer = projectMachineProcesses(read, { ...request, detailToken: detail }, { accountId: 'owner', custodianAccountId: 'owner' },
            { ...options, history: ref => metrics.history(undefined, [ref])[ref] });
        expect(answer.history?.['session:owner-session']).toEqual([
            { capturedAtMs: 100000, memoryBytes: 41 }, { capturedAtMs: 102000, memoryBytes: 41, cpuPercent: 0 },
        ]);
        expect(answer.history?.[detail]).toHaveLength(2);
        expect(answer.history?.[processRef(20, read.roots[1].start)]).toBeUndefined();
        const recipient = projectMachineProcesses(read, request, { accountId: 'guest', custodianAccountId: 'owner' }, { ...options, history: ref => metrics.history(undefined, [ref])[ref] });
        expect(Object.keys(recipient.history ?? {})).toEqual(['session:guest-session']);
    });
    it('keeps previously observed owner totals when a member exits instead of rewriting past memory', () => {
        const read = setup();
        const metrics = createProcessMetrics();
        metrics.observe(read.snapshot, 2000, metricOwners(read));
        const snapshot = { ...read.snapshot, capturedAtMs: 102000, rows: read.snapshot.rows.filter(row => row.pid !== 21) };
        const current = { ...read, snapshot, rows: read.rows.filter(row => row.pid !== 21) };
        metrics.observe(snapshot, 2000, metricOwners(current));
        const answer = projectMachineProcesses(current, request, { accountId: 'owner', custodianAccountId: 'owner' }, { ...options, history: ref => metrics.history(undefined, [ref])[ref] });
        expect(answer.history?.['session:owner-session']).toEqual([
            { capturedAtMs: 100000, memoryBytes: 41 }, { capturedAtMs: 102000, memoryBytes: 20, cpuPercent: 0 },
        ]);
    });
});

describe('inline credential privacy through process presentation', () => {
    it.each(['argv', 'string'] as const)('redacts %s before details and Action/agent answers can disclose it', form => {
        const read = setup();
        const args = ['env', 'TOKEN=ordinary-token', 'PASSWORD=ordinary-password', 'API_KEY=ordinary-key', 'SECRET=ordinary-secret',
            'agent', 'https://alice:url-password@example.test/path', '--port=5173'];
        const snapshot = { ...read.snapshot, rows: read.snapshot.rows.map(row => row.pid === 21
            ? { ...row, argv: form === 'argv' ? args : undefined, commandLine: form === 'string' ? args.join(' ') : undefined } : row) };
        const detailToken = processRef(21, snapshot.rows.find(row => row.pid === 21)!.start);
        const answer = projectMachineProcesses({ ...read, snapshot }, { ...request, detailToken },
            { accountId: 'owner', custodianAccountId: 'owner' }, options);
        const command = answer.owners.flatMap(owner => owner.members).find(row => row.pid === 21)?.command;
        expect(command).toBe('env TOKEN=[REDACTED] PASSWORD=[REDACTED] API_KEY=[REDACTED] SECRET=[REDACTED] agent https://[REDACTED]@example.test/path --port=5173');
        expect(MachineProcessesAnswerV1Schema.safeParse(answer).success).toBe(true);
        expect(JSON.stringify(answer)).not.toMatch(/ordinary-token|ordinary-password|ordinary-key|ordinary-secret|alice|url-password/);
    });
});
