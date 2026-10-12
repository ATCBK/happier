import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RpcHandlerMap, RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { createProcessOwnershipRuntime } from '@/daemon/processes/ownership/processOwnershipRuntime';
import { createLeftBehindPass } from '@/daemon/processes/leftBehind/leftBehindPass';
import { createMachineProcessesView } from '@/daemon/processes/view/createMachineProcessesView';
import { createMachineVitalsSampler } from '@/daemon/vitals/createMachineVitalsSampler';
import { createMinuteHistoryStore } from '@/daemon/vitals/history/minuteHistoryStore';
import { createLinuxMachineVitalsReader } from '@/daemon/vitals/readers/linux';
import { parseLinuxProcStartTimeMs } from '@happier-dev/cli-common/processInstance';
import { MachineProcessesAnswerV1Schema, MachineProcessesCheckResultV1Schema } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { registerDaemonProcessesRpcHandlers } from './daemonProcesses';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
it('projects a real Linux census through admitted RPC and fences stale installation and post-read revocation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'machine-process-rpc-')); directories.push(directory);
    const stat = (pid: number) => `${pid} (worker) ${['S', '1', '42', '42', '0', '42', ...Array(5).fill('0'), '12', '8', ...Array(6).fill('0'), String(pid * 10), '4096', '3'].join(' ')}`;
    const auxv = Buffer.alloc(32); auxv.writeBigUInt64LE(6n); auxv.writeBigUInt64LE(4096n, 8);
    let unavailable = false;
    // Only /proc filesystem reads are substituted; census decoding and all domain/RPC logic remain real.
    const runtime = createProcessOwnershipRuntime({ selfPid: 42, platform: 'linux', daemonScopeKey: '123456789abc',
        listRoots: snapshot => [{ owner: { kind: 'session', sessionId: 's' }, pid: 42,
            start: snapshot.rows.find(row => row.pid === 42)!.start, live: true, ownerCreatedAtMs: 0 }],
        censusDependencies: { platform: 'linux', selfPid: 42, linuxBoundary: {
            async readdir() { if (unavailable) throw new Error('OS denied'); return ['42', '43']; },
            async readFile(path) {
                if (path === '/proc/self/auxv') return auxv;
                const pid = Number(path.split('/')[2]);
                if (path.endsWith('/stat')) return stat(pid);
                if (path.endsWith('/status')) return 'Uid:\t1000\t1000\t1000\t1000\n';
                if (path.endsWith('/cmdline')) return 'agent\0--token\0must-not-disclose\0';
                if (path.endsWith('/cgroup')) return '0::/user.slice\n';
                if (path.endsWith('/environ')) return '';
                throw new Error('not readable');
            }, async readlink(path) { return path.endsWith('/exe') ? '/usr/bin/worker' : '/work'; },
        } } });
    const pass = createLeftBehindPass({ processOwnershipRuntime: runtime });
    const sampler = createMachineVitalsSampler({ readers: createLinuxMachineVitalsReader({ root: directory }), historyStore: await createMinuteHistoryStore({ directory }) });
    const view = createMachineProcessesView({ processOwnershipRuntime: runtime, leftBehind: pass, machineVitals: sampler,
        platform: 'linux', selfPid: 42, bootTimeMs: 1000, allProcessesVisible: () => true,
        requesterForOwner: () => ({ accountId: 'guest', displayName: 'Guest' }) });
    const handlers: RpcHandlerMap = new Map();
    const registrar: RpcHandlerRegistrar = { registerHandler: (method, handler) => { handlers.set(method, handler); } };
    registerDaemonProcessesRpcHandlers(registrar, { view, target: () => ({ serverId: 'home', machineId: 'm', installationId: 'i', custodianAccountId: 'owner' }) });
    const context: RpcHandlerContext = { signal: new AbortController().signal, machineAdmission: {
        machineId: 'm', installationId: 'i', custodianAccountId: 'owner', actorAccountId: 'guest', role: 'use', encryptionMode: 'plain',
    }, verifyMachineAdmissionCurrent: async () => true };
    const list = handlers.get(RPC_METHODS.MACHINES_PROCESSES_LIST)!;
    const answer = MachineProcessesAnswerV1Schema.parse(await list({ serverId: 'browser-home', machineId: 'm' }, context));
    expect(answer.state).toBe('live');
    const nativeStartTimeMs = parseLinuxProcStartTimeMs(stat(42));
    if (nativeStartTimeMs === null) throw new Error('Expected a valid native start time in the procfs fixture');
    expect(answer.owners[0].members[0]).toMatchObject({ pid: 42, command: 'agent --token [REDACTED]', startedAtMs: 1000 + nativeStartTimeMs });
    const check = MachineProcessesCheckResultV1Schema.parse(await handlers.get(RPC_METHODS.MACHINES_PROCESSES_CHECK)!({ machineId: 'm', refs: [answer.owners[0].members[0].ref] }, context));
    expect(check.checks[0]).toMatchObject({ present: true, identityEqual: true, owner: { kind: 'session', sessionId: 's' } });
    await expect(list({ machineId: 'm' }, { ...context, machineAdmission: { ...context.machineAdmission!, installationId: 'replaced' } })).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
    let validations = 0;
    await expect(list({ machineId: 'm' }, { ...context, verifyMachineAdmissionCurrent: async () => ++validations === 1 })).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
    unavailable = true;
    expect(MachineProcessesAnswerV1Schema.parse(await list({ machineId: 'm' }, context))).toMatchObject({ state: 'unavailable', reason: 'read_failed' });
    view.dispose(); pass.dispose(); await sampler.stop();
});
