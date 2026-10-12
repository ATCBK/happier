import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios, { AxiosHeaders } from 'axios';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { publishServerHttpRuntimeOrigin } from '@/api/client/serverHttpBaseUrl';
import { createCliActionDeps } from './createCliActionDeps';
import { MachineProcessesGetResultV1Schema } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import type { RpcHandlerContext, RpcHandlerMap, RpcHandlerRegistrar } from '@/api/rpc/types';
import { createProcessOwnershipRuntime } from '@/daemon/processes/ownership/processOwnershipRuntime';
import { createLeftBehindPass } from '@/daemon/processes/leftBehind/leftBehindPass';
import { createProcessActionExecutor } from '@/daemon/processes/actions/processActionExecutor';
import { createMachineProcessesView } from '@/daemon/processes/view/createMachineProcessesView';
import { registerDaemonProcessesRpcHandlers } from '@/rpc/handlers/daemonProcesses';
import { createLinuxVitalsFixture } from '@/daemon/vitals/readers/linux.testkit';
import { createLinuxMachineVitalsReader } from '@/daemon/vitals/readers/linux';
import { createMinuteHistoryStore } from '@/daemon/vitals/history/minuteHistoryStore';
import { createMachineVitalsSampler } from '@/daemon/vitals/createMachineVitalsSampler';
import { processRef } from '@/daemon/processes/view/processRef';
import { join } from 'node:path';

const io = vi.hoisted(() => vi.fn());
// HTTP and Socket.IO are genuine boundaries; Action routing, exact targeting and codecs stay real.
vi.mock('socket.io-client', () => ({ io }));

const responses: unknown[] = [];
const requests: { method: string; params: unknown }[] = [];
let releaseHome = () => {};
let receive: ((method: string, params: unknown) => Promise<unknown>) | undefined;
const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
const context = { surface: 'cli', authority: 'present_user', serverId: 'home' } as const;
const params = { token: credentials.token, credentials, sessionId: 'cli-global', serverId: 'home',
  serverHttpBaseUrl: 'https://home.invalid', mode: 'plain', ctx: null } as const;

describe('CLI machine Processes Action transport', () => {
  beforeEach(() => {
    responses.length = 0;
    requests.length = 0;
    receive = undefined;
    releaseHome = publishServerHttpRuntimeOrigin('https://home.invalid', 'https');
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (!path.startsWith('/v1/machines/')) throw new Error(`Unexpected HTTP read: ${path}`);
      return { status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() },
        data: { machine: { id: decodeURIComponent(path.slice('/v1/machines/'.length)),
          storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } } };
    });
    bindApiSessionSocketMock(io, createApiSessionSocketStub({ emitWithAck: (event, payload) => {
      if (event !== SOCKET_RPC_EVENTS.CALL || !payload || typeof payload !== 'object'
        || !('method' in payload) || typeof payload.method !== 'string' || !('params' in payload)) {
        throw new Error('Unexpected Machine RPC boundary request');
      }
      requests.push({ method: payload.method, params: payload.params });
      if (receive) return receive(payload.method, payload.params).then(result => ({ ok: true, result }));
      if (!responses.length) throw new Error(`Unexpected Machine RPC: ${payload.method}`);
      return { ok: true, result: responses.shift() };
    } }));
  });
  afterEach(() => { releaseHome(); vi.restoreAllMocks(); });

  it('reads a guest process, requires Action confirmation and ends only that reviewed native target', async () => {
    const fixture = await createLinuxVitalsFixture();
    const sampler = createMachineVitalsSampler({ readers: createLinuxMachineVitalsReader({ root: fixture.root }),
      historyStore: await createMinuteHistoryStore({ directory: join(fixture.root, 'history') }) });
    const selfPid = process.pid;
    const owner = { kind: 'session', sessionId: 'guest-session' } as const;
    const rows = new Map([selfPid, 20, 21, 30].map(pid => [pid, { pid, ppid: pid === 21 ? 20 : 1, pgid: pid,
      name: 'tool', start: { startTimeMs: pid, native: `darwin-proc:${pid}:0:${pid}` },
      principal: { kind: 'uid', value: '501' }, memory: { bytes: pid, kind: 'rss' }, cpuTimeUs: 0,
      ...(pid === 21 ? { argv: ['env', 'TOKEN=ordinary-action-secret', 'agent', 'https://alice:ordinary-url-secret@example.test/path'] } : {}),
      ...(pid === 20 || pid === 21 ? { ownerTag: 'v1.123456789abc.session.guest-session' } : {}) }]));
    // Native census and signals are the OS boundary. Ownership, projection, approval and termination stay real.
    const censusDependencies = { platform: 'darwin' as const, selfPid, helperExecutablePath: '/fixture-helper',
      execFile: async () => ({ stdout: JSON.stringify({ v: 1, capturedAtMs: 1000, logicalCpus: 4, rows: [...rows.values()] }) }) };
    const ownership = createProcessOwnershipRuntime({ daemonScopeKey: '123456789abc', selfPid, platform: 'darwin',
      censusDependencies, listRoots: snapshot => snapshot.rows.filter(row => row.pid === selfPid || row.pid === 20).map(row => ({
        owner: row.pid === selfPid ? { kind: 'happier' as const } : owner, pid: row.pid, start: row.start, live: true, ownerCreatedAtMs: 0,
      })) });
    const leftBehind = createLeftBehindPass({ processOwnershipRuntime: ownership });
    const requesterForOwner = () => ({ accountId: 'guest', displayName: 'Guest' });
    const view = createMachineProcessesView({ processOwnershipRuntime: ownership, leftBehind, machineVitals: sampler,
      platform: 'darwin', selfPid, allProcessesVisible: () => false, requesterForOwner });
    const signals: number[] = [];
    const actions = createProcessActionExecutor({ ownership, leftBehind, selfPid, platform: 'darwin',
      allProcessesVisible: () => false, requesterForOwner, systemBoundary: { platform: 'darwin', censusDependencies,
        kill(pid) { signals.push(pid); rows.delete(pid); }, async wait() {} } });
    const handlers: RpcHandlerMap = new Map();
    const registrar: RpcHandlerRegistrar = { registerHandler(method, handler) { handlers.set(method, handler); } };
    registerDaemonProcessesRpcHandlers(registrar, { view, actions, target: () => ({ serverId: 'home', machineId: 'selected',
      installationId: 'install', custodianAccountId: 'custodian' }) });
    const admitted: RpcHandlerContext = { signal: new AbortController().signal,
      machineAdmission: { machineId: 'selected', installationId: 'install', custodianAccountId: 'custodian',
        actorAccountId: 'custodian', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
    receive = (method, input) => Promise.resolve(handlers.get(method.slice('selected:'.length))!(input, admitted));
    const executor = createActionExecutor(createCliActionDeps(params));
    try {
      const ref = processRef(21, rows.get(21)!.start);
      const read = await executor.execute('machines.processes.get', { machineId: 'selected', ref }, context);
      expect(read.ok).toBe(true);
      if (!read.ok) throw new Error(read.error);
      const detail = MachineProcessesGetResultV1Schema.parse(read.result);
      const selected = detail.row;
      expect(detail).toMatchObject({ row: { ref, level: 'proven' }, owner });
      expect(detail.row).toMatchObject({ command: 'env TOKEN=[REDACTED] agent https://[REDACTED]@example.test/path' });
      expect(JSON.stringify(read)).not.toMatch(/ordinary-action-secret|ordinary-url-secret|alice/);
      if (!selected || !('level' in selected)) throw new Error('Expected a Happier process');
      const input = { machineId: 'selected', targets: [{ ref, expect: { level: selected.level, owner } }], tree: false };
      expect(await executor.execute('machines.processes.kill', input, context))
        .toMatchObject({ ok: false, errorCode: 'approval_origin_unavailable' });
      expect(signals).toEqual([]);
      expect(requests).toHaveLength(1);
      expect(await executor.execute('machines.processes.kill', input,
        { ...context, presentUserConfirmation: { actionId: 'machines.processes.kill' } }))
        .toMatchObject({ ok: true, result: { status: 'ended', outcomes: [{ ref, outcome: 'ended' }] } });
      expect(signals).toEqual([21]);
      expect(rows.has(21)).toBe(false);
      expect(rows.has(30)).toBe(true);
      expect(await executor.execute('machines.processes.get', { machineId: 'selected', ref }, context))
        .toEqual({ ok: true, result: { row: null } });
    } finally { view.dispose(); leftBehind.dispose(); await sampler.stop(); await fixture.cleanup(); }
  });

  it('reaches the exact selected machine through authenticated ingress even when a direct transport exists', async () => {
    const invoke = vi.fn(async () => { throw new Error('Unadmitted local transport'); });
    const executor = createActionExecutor(createCliActionDeps({ ...params,
      machineActionDirectTargetTransport: { machineId: 'selected', invoke } }));
    const controller = new AbortController();
    const signal = controller.signal;
    responses.push({ row: null });
    expect(await executor.execute('machines.processes.get', { machineId: 'selected', ref: 'process-ref' },
      { ...context, signal })).toEqual({ ok: true, result: { row: null } });
    expect(requests).toEqual([{ method: `selected:${RPC_METHODS.MACHINES_PROCESSES_GET}`,
      params: { serverId: 'home', machineId: 'selected', ref: 'process-ref' } }]);
    expect(axios.get).toHaveBeenCalledWith('https://home.invalid/v1/machines/selected', expect.objectContaining({
      signal: expect.any(AbortSignal), headers: expect.objectContaining({ Authorization: 'Bearer token' }),
    }));
    expect(invoke).not.toHaveBeenCalled();
    // The request owner may compose its lifetime with the caller's signal.
    // Prove cancellation reaches HTTP and prevents RPC/disclosure, rather than requiring object identity.
    vi.mocked(axios.get).mockImplementationOnce(async (_url, config) => {
      const admittedSignal = config?.signal;
      expect(admittedSignal).toBeInstanceOf(AbortSignal);
      if (!(admittedSignal instanceof AbortSignal)) throw new Error('Missing HTTP cancellation');
      expect(admittedSignal.aborted).toBe(false);
      controller.abort(new Error('cancel-process-read'));
      expect(admittedSignal.aborted).toBe(true);
      expect(admittedSignal.reason).toBe(signal.reason);
      return { status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() },
        data: { machine: { id: 'selected', storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } } };
    });
    expect(await executor.execute('machines.processes.get', { machineId: 'selected', ref: 'process-ref' },
      { ...context, signal })).toMatchObject({ ok: false });
    expect(requests).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('preserves receiving Action failure and deferred approval, and rejects malformed process output', async () => {
    const executor = createActionExecutor(createCliActionDeps(params));
    const actionId = 'machines.processes.kill';
    const input = { machineId: 'selected', targets: [{ ref: 'process-ref', expect: { level: 'proven' } }], tree: false };
    const approved = { ...context, presentUserConfirmation: { actionId } } as const;
    const failure = { ok: false, errorCode: 'expectation_changed', error: 'expectation_changed' };
    responses.push(failure);
    expect(await executor.execute(actionId, input, approved)).toEqual(failure);
    const deferred = { kind: 'approval_request_created', actionId, artifactId: 'approval' };
    responses.push(deferred);
    expect(await executor.execute(actionId, input, approved)).toEqual({ ok: true, result: deferred });
    responses.push({ status: 'ended', outcomes: [{ ref: 'process-ref', outcome: 'ended', command: 'private' }] });
    expect(await executor.execute(actionId, input, approved)).toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
  });

  it('rejects another Home before transport and rechecks retired credentials after the response', async () => {
    let current = true;
    const executor = createActionExecutor(createCliActionDeps({ ...params, isCredentialCurrent: async () => current }));
    expect(await executor.execute('machines.processes.get', { serverId: 'other', machineId: 'selected', ref: 'process-ref' }, context))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(requests).toEqual([]);
    vi.mocked(axios.get).mockImplementationOnce(async () => {
      current = false;
      return { status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() },
        data: { machine: { id: 'selected', storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } } };
    });
    responses.push({ row: null });
    expect(await executor.execute('machines.processes.get', { machineId: 'selected', ref: 'process-ref' }, context))
      .toMatchObject({ ok: false, errorCode: 'action_failed', error: 'scope-retired' });
  });
});
