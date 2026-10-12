import { expect, it } from 'vitest';
import { accountSettingsParse } from '../../account/settings/accountSettings.js';
import { applyInstallablePolicyOverride } from '../../installables/policy.js';
import { buildMachineInstallablePolicySettingMutation, readMachineInstallablePolicySetting } from './machineInstallablePolicySetting.js';

it('applies a sparse installable change and refuses unrepresentable prototype-named keys', () => {
  const settings = accountSettingsParse({ installablesPolicyByMachineId: {
    machine: { other: { autoUpdateMode: 'notify' } }, peer: { tool: { autoInstallWhenNeeded: true } },
  } });
  const changed = buildMachineInstallablePolicySettingMutation(settings, 'machine', {
    installableKey: 'tool', patch: { autoInstallWhenNeeded: false },
  });
  expect(changed?.installablesPolicyByMachineId).toMatchObject({
    machine: { other: { autoUpdateMode: 'notify' }, tool: { autoInstallWhenNeeded: false } },
    peer: { tool: { autoInstallWhenNeeded: true } },
  });
  const next = accountSettingsParse({ ...settings, ...changed });
  const beforePrototype = Object.getPrototypeOf(next.installablesPolicyByMachineId);
  const prepared = applyInstallablePolicyOverride({ prev: next.installablesPolicyByMachineId,
    machineId: '__proto__', installableKey: 'constructor', patch: { autoUpdateMode: 'off' } });
  expect(Object.hasOwn(prepared, '__proto__')).toBe(true);
  const special = buildMachineInstallablePolicySettingMutation(next, '__proto__', {
    installableKey: 'constructor', patch: { autoUpdateMode: 'off' },
  });
  expect(special).toBeNull();
  expect(Object.getPrototypeOf(next.installablesPolicyByMachineId)).toBe(beforePrototype);
  expect(Object.hasOwn(next.installablesPolicyByMachineId, '__proto__')).toBe(false);
  expect(readMachineInstallablePolicySetting(next, '__proto__')).toEqual({});
});
