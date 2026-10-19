import { expect, it } from 'vitest';
import { reconcileExternalActionTarget, resolveExternalActionMachineTarget } from './reconcileExternalActionTarget';

it('selects an inherited spawn Machine before creation choices are resolved while retaining explicit locality', () => {
  const spawn = { actionId: 'session.spawn_new' as const,
    rawInput: { directory: { kind: 'path', path: '/tmp' } }, fallbackMachineId: 'caller-machine' };
  expect(resolveExternalActionMachineTarget(spawn)).toEqual({ kind: 'ready', machineId: 'caller-machine' });
  const selected = { ...spawn, rawInput: { ...spawn.rawInput,
    executionTarget: { serverId: 'home', machineId: 'selected-machine' } } };
  expect(resolveExternalActionMachineTarget(selected)).toEqual({ kind: 'ready', machineId: 'selected-machine' });
  expect(reconcileExternalActionTarget({ ...selected, target: { kind: 'machine', machineId: 'other' },
    currentMachineId: 'other' })).toMatchObject({ kind: 'rejected', execution: { errorCode: 'target_not_local' } });
  expect(resolveExternalActionMachineTarget({ ...spawn, rawInput: { ...spawn.rawInput, agentTarget: null } }))
    .toMatchObject({ kind: 'rejected', execution: { errorCode: 'invalid_parameters' } });
});

it('binds plugin installation to its semantic Machine at caller selection and actual daemon ingress', () => {
  const install = { actionId: 'plugins.install' as const,
    rawInput: { machineId: 'selected-machine', source: { kind: 'marketplace' as const,
      sourceId: 'marketplace:community-npm', pluginId: 'acme.plugin', packageName: '@acme/plugin', version: '1.0.0' } } };
  expect(resolveExternalActionMachineTarget({ ...install, fallbackMachineId: 'ambient-machine' }))
    .toEqual({ kind: 'ready', machineId: 'selected-machine' });
  expect(reconcileExternalActionTarget({ ...install, currentMachineId: 'selected-machine',
    target: { kind: 'machine', machineId: 'selected-machine' } }))
    .toMatchObject({ kind: 'ready', target: { kind: 'machine', machineId: 'selected-machine' } });
  expect(reconcileExternalActionTarget({ ...install, currentMachineId: 'other-machine',
    target: { kind: 'machine', machineId: 'other-machine' } }))
    .toMatchObject({ kind: 'rejected', execution: { errorCode: 'target_not_local' } });
});

const input = {
  actionId: 'sessions.external.candidates.list' as const,
  rawInput: { machineId: 'addressed-machine', agentId: 'claude', source: { kind: 'claudeConfig', configDir: '/repo' } },
  fallbackMachineId: 'unrelated-local-machine',
};

it('selects the parsed Machine rather than the ambient local Machine and refuses a conflicting envelope', () => {
  expect(resolveExternalActionMachineTarget(input)).toEqual({ kind: 'ready', machineId: 'addressed-machine' });
  expect(resolveExternalActionMachineTarget({ ...input, target: { kind: 'machine', machineId: 'other' } }))
    .toMatchObject({ kind: 'rejected', execution: { errorCode: 'target_not_local' } });
  expect(resolveExternalActionMachineTarget({ ...input, ownerMachineId: 'other' }))
    .toMatchObject({ kind: 'rejected', execution: { errorCode: 'target_not_local' } });
});

it('uses authenticated linked Session ownership for operation placement and refuses a different explicit Machine', () => {
  const operation = { actionId: 'sessions.external.operation.status.get' as const,
    rawInput: { sessionId: 'session-1', operationId: 'operation-1', revision: 1 },
    ownerMachineId: 'owning-machine', fallbackMachineId: 'unrelated-local-machine' };
  expect(resolveExternalActionMachineTarget(operation)).toEqual({ kind: 'ready', machineId: 'owning-machine' });
  expect(resolveExternalActionMachineTarget({ ...operation, target: { kind: 'machine', machineId: 'other' } }))
    .toMatchObject({ kind: 'rejected', execution: { errorCode: 'target_not_local' } });
});

const serviceControl = {
  actionId: 'localServices.actions.stopManaged' as const,
  rawInput: { requestId: 'exact-service-stop', action: 'stop_managed' as const, confirmationNonce: 'reviewed-stop', force: false,
    target: { kind: 'managed_service' as const, machineId: 'addressed-machine', managedServiceId: 'actual-instance' } },
  fallbackMachineId: 'unrelated-local-machine',
};

it('selects the strict service control occurrence Machine and preserves captured-target refusal', () => {
  expect(resolveExternalActionMachineTarget(serviceControl)).toEqual({ kind: 'ready', machineId: 'addressed-machine' });
  expect(resolveExternalActionMachineTarget({ ...serviceControl, target: { kind: 'machine', machineId: 'other' } }))
    .toMatchObject({ kind: 'rejected', execution: { errorCode: 'target_not_local' } });
  expect(resolveExternalActionMachineTarget({ ...serviceControl, rawInput: { ...serviceControl.rawInput, action: 'restart_managed' } }))
    .toMatchObject({ kind: 'rejected', execution: { errorCode: 'invalid_parameters' } });
});

it('refuses a service control selecting another Machine at actual daemon ingress', () => {
  expect(reconcileExternalActionTarget({ ...serviceControl, target: { kind: 'machine', machineId: 'other' }, currentMachineId: 'other' }))
    .toMatchObject({ kind: 'rejected', execution: { errorCode: 'target_not_local' } });
  expect(reconcileExternalActionTarget({ ...serviceControl, target: { kind: 'machine', machineId: 'addressed-machine' },
    currentMachineId: 'addressed-machine' }))
    .toMatchObject({ kind: 'ready', target: { kind: 'machine', machineId: 'addressed-machine' } });
});
