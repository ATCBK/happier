import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { MachineResourcesPolicyV1Schema } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';
import { createCliActionDeps } from './createCliActionDeps';

afterEach(() => vi.restoreAllMocks());

const credentials = { token: 'token', encryption: null };
const params = { token: credentials.token, credentials, sessionId: 'cli-global', serverId: 'home',
  serverHttpBaseUrl: 'https://home.example.test', mode: 'plain', ctx: null } as const;
const context = { surface: 'cli', authority: 'present_user', serverId: 'home' } as const;
const processEffect = { actionId: 'machines.processes.kill',
  input: { machineId: 'selected', targets: [{ ref: 'process-ref', expect: { level: 'proven' } }], tree: false },
  receipt: { status: 'ended', outcomes: [{ ref: 'process-ref', outcome: 'ended' }] } } as const;
const guardEffect = { actionId: 'machines.guard.idleStop.keepRunning',
  input: { machineId: 'selected', sessionId: 'session' }, receipt: { status: 'kept' } } as const;
const guardUndo = { actionId: 'machines.guard.activity.undo',
  input: { machineId: 'selected', entryId: 'entry' }, receipt: { status: 'restored', entryIds: ['entry'] } } as const;
const reads = [
  { actionId: 'machines.processes.get', input: { machineId: 'selected', ref: 'process-ref' }, receipt: { row: null } },
  { actionId: 'machines.guard.activity.list', input: { machineId: 'selected', range: 'today' },
    receipt: { entries: [], counts: { stopped: 0, cleanedUp: 0, needsLook: 0, others: 0 }, asOf: 1 } },
] as const;

describe('CLI captured Machine acknowledgement settlement', () => {
  it('retains delayed policy save completion without a subordinate acknowledgement deadline', async () => {
    const transport = await import('@/session/transport/rpc/machineRpc');
    const controller = new AbortController();
    let current = true;
    let acknowledge!: () => void;
    let admitted!: () => void;
    const dispatched = new Promise<void>(resolve => { admitted = resolve; });
    const receipt = { status: 'applied', revision: 2,
      policy: MachineResourcesPolicyV1Schema.parse({ v: 1, processes: { allProcessesVisible: true } }) };
    // The Machine RPC boundary owns its default deadline. A late acknowledged save survives only with effect-owned completion.
    vi.spyOn(transport, 'callExactMachineRpc').mockImplementation(async request => {
      admitted();
      await new Promise<void>(resolve => { acknowledge = resolve; });
      if (request.timeoutMs !== null) throw Object.assign(new Error('Machine RPC call timeout'), { code: 'MACHINE_RPC_TIMEOUT' });
      return receipt;
    });
    const executor = createActionExecutor(createCliActionDeps({ ...params, isCredentialCurrent: async () => current }));
    const result = executor.execute('machines.resources.policy.set', { machineId: 'selected', expectedRevision: 1,
      patch: { processes: { allProcessesVisible: true } } }, { ...context, signal: controller.signal });
    await dispatched;
    controller.abort();
    current = false;
    acknowledge();
    expect(await result).toEqual({ ok: true, result: receipt });
  });

  for (const retirement of ['cancellation', 'credentials'] as const) {
    it.each([processEffect, guardEffect, guardUndo])(`retains delayed $actionId acknowledgement after ${retirement}`, async action => {
      const transport = await import('@/session/transport/rpc/machineRpc');
      const controller = new AbortController();
      let current = true;
      let acknowledge!: (receipt: unknown) => void;
      let admitted!: () => void;
      const dispatched = new Promise<void>(resolve => { admitted = resolve; });
      // Authenticated daemon transport is the boundary; model a consumed response delivered to its captured invoker.
      const rpc = vi.spyOn(transport, 'callExactMachineRpc').mockImplementation(() => {
        admitted();
        return new Promise(resolve => { acknowledge = resolve; });
      });
      const executor = createActionExecutor(createCliActionDeps({ ...params, isCredentialCurrent: async () => current }));
      const result = executor.execute(action.actionId, action.input, { ...context, signal: controller.signal,
        presentUserConfirmation: { actionId: action.actionId } });
      await dispatched;
      if (retirement === 'cancellation') controller.abort(); else current = false;
      acknowledge(action.receipt);
      expect(await result).toEqual({ ok: true, result: action.receipt });
      expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: null }));
    });

    it.each(reads)(`withholds delayed $actionId disclosure after ${retirement}`, async action => {
      const transport = await import('@/session/transport/rpc/machineRpc');
      const controller = new AbortController();
      let current = true;
      let acknowledge!: (receipt: unknown) => void;
      let admitted!: () => void;
      const dispatched = new Promise<void>(resolve => { admitted = resolve; });
      vi.spyOn(transport, 'callExactMachineRpc').mockImplementation(() => {
        admitted();
        return new Promise(resolve => { acknowledge = resolve; });
      });
      const executor = createActionExecutor(createCliActionDeps({ ...params, isCredentialCurrent: async () => current }));
      const result = executor.execute(action.actionId, action.input, { ...context, signal: controller.signal });
      await dispatched;
      if (retirement === 'cancellation') controller.abort(); else current = false;
      acknowledge(action.receipt);
      expect(await result).toMatchObject({ ok: false, errorCode: 'action_failed' });
    });

    it(`retains target-local Activity Undo acknowledgement after ${retirement}`, async () => {
      const controller = new AbortController();
      let current = true;
      let acknowledge!: (receipt: unknown) => void;
      let admitted!: () => void;
      const dispatched = new Promise<void>(resolve => { admitted = resolve; });
      const executor = createActionExecutor(createCliActionDeps({ ...params, isCredentialCurrent: async () => current,
        // The target-local daemon restoration port is the boundary, with its original receipt kept intact.
        machineGuardAction: async () => { admitted(); return new Promise(resolve => { acknowledge = resolve; }); } }));
      const result = executor.execute(guardUndo.actionId, guardUndo.input, { ...context, signal: controller.signal });
      await dispatched;
      if (retirement === 'cancellation') controller.abort(); else current = false;
      acknowledge(guardUndo.receipt);
      expect(await result).toEqual({ ok: true, result: guardUndo.receipt });
    });
  }

  it('refuses effects before dispatch when captured credentials are already retired', async () => {
    const transport = await import('@/session/transport/rpc/machineRpc');
    const rpc = vi.spyOn(transport, 'callExactMachineRpc');
    const executor = createActionExecutor(createCliActionDeps({ ...params, isCredentialCurrent: async () => false }));
    expect(await executor.execute(guardEffect.actionId, guardEffect.input, context))
      .toMatchObject({ ok: false, errorCode: 'action_failed', error: 'scope-retired' });
    expect(rpc).not.toHaveBeenCalled();
  });
});
