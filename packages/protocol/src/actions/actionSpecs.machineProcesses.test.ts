import { describe, expect, it } from 'vitest';
import { listActionSpecs } from './actionSpecs.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { resolveMachineRpcRoutePolicy } from '../machines/peer/mediation/rpc/routePolicyV1.js';

const ids = ['machines.processes.list', 'machines.processes.get', 'machines.processes.check',
  'machines.processes.stop', 'machines.processes.startAgain', 'machines.processes.kill',
  'machines.processes.leftBehind.cleanUp'] as const;

describe('Machine Processes Action contract', () => {
  it('exposes every process operation through the canonical catalog and Machine admission', () => {
    for (const id of ids) {
      const spec = listActionSpecs().find(spec => spec.id === id);
      expect(spec, id).toBeDefined();
      if (!spec) continue;
      expect(spec.executionPlacement).toBe('machine');
      expect(spec.surfaces).toMatchObject({ ui: true, agent: true, mcp: true, cli: true, rpc: true });
      const route = resolveMachineRpcRoutePolicy(spec.bindings.rpcMethod!);
      expect(route).toMatchObject(id === 'machines.processes.list' || id === 'machines.processes.get' || id === 'machines.processes.check'
        ? { routeClass: 'direct_ephemeral', sharedMachineAccess: 'use' }
        : { routeClass: 'server_required', sharedMachineAccess: 'use', actionSpecId: id });
    }
  });

  it('defaults stop, kill and cleanup to Ask first and respects each Action’s own waiver', () => {
    for (const actionId of ['machines.processes.stop', 'machines.processes.kill', 'machines.processes.leftBehind.cleanUp'] as const) {
      const spec = listActionSpecs().find(spec => spec.id === actionId);
      expect(spec).toBeDefined();
      if (!spec) continue;
      for (const surface of ['agent', 'mcp', 'cli'] as const) {
        const context = { surface, authority: 'account_automation' } as const;
        expect(resolveActionApprovalRouting({ actionId: spec.id, spec, context })).toMatchObject({ required: true, result: 'required' });
        const settings = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: [surface] } });
        expect(resolveActionApprovalRouting({ actionId: spec.id, spec, context, settings }).required).toBe(false);
      }
    }
  });

  it('narrows the reviewed set without adding a target or escalating a process kill into a tree kill', () => {
    const spec = listActionSpecs().find(spec => spec.id === 'machines.processes.kill');
    expect(spec?.approvalNarrowing).toBeDefined();
    if (!spec?.approvalNarrowing) return;
    const target = { ref: 'ref-a', expect: { level: 'proven', owner: { kind: 'session', sessionId: 's' } } };
    const original = { machineId: 'm', targets: [target, { ...target, ref: 'ref-b' }], tree: true };
    expect(spec.approvalNarrowing.narrow(original, { ...original, targets: [target], tree: false })).not.toBeNull();
    expect(spec.approvalNarrowing.narrow(original, { ...original, targets: [{ ...target, ref: 'other' }] })).toBeNull();
    expect(spec.approvalNarrowing.narrow({ ...original, tree: false }, { ...original, targets: [target] })).toBeNull();
    const cleanup = listActionSpecs().find(spec => spec.id === 'machines.processes.leftBehind.cleanUp');
    expect(cleanup?.approvalNarrowing).toBeDefined();
    expect(cleanup?.approvalNarrowing?.narrow({ machineId: 'm', refs: ['a', 'b'] }, { machineId: 'm', refs: ['b'] })).toEqual({ machineId: 'm', refs: ['b'] });
    expect(cleanup?.approvalNarrowing?.narrow({ machineId: 'm', refs: ['a'] }, { machineId: 'm', refs: ['b'] })).toBeNull();
  });

  it('binds the All processes CLI spelling to the one resources policy writer', () => {
    const spec = listActionSpecs().find(spec => spec.id === 'machines.resources.policy.set');
    expect(spec?.cli?.commands.some(command => command.path.join(' ') === 'machines processes all')).toBe(true);
    expect(spec?.cli?.bindInput?.({ machineId: 'm', expectedRevision: 2, allProcessesVisible: true },
      { actionId: 'machines.resources.policy.set', invocationId: 'i' }))
      .toEqual({ machineId: 'm', expectedRevision: 2, patch: { processes: { allProcessesVisible: true } } });
  });
});
