import type {
  InstallableAutoUpdateMode,
  InstallableDefaultPolicy,
  InstallableDependencyDescriptor,
} from './index.js';

export type InstallablePolicyOverride = Readonly<{
  autoInstallWhenNeeded?: boolean;
  autoUpdateMode?: InstallableAutoUpdateMode;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readInstallablesPolicyByMachineId(
  settingsLike: unknown,
): Record<string, Record<string, InstallablePolicyOverride>> {
  const raw = isRecord(settingsLike) ? settingsLike.installablesPolicyByMachineId : null;
  if (!isRecord(raw)) return {};

  const out: Record<string, Record<string, InstallablePolicyOverride>> = {};
  for (const [machineId, byKeyRaw] of Object.entries(raw)) {
    if (!isRecord(byKeyRaw)) continue;
    const byKey: Record<string, InstallablePolicyOverride> = {};
    for (const [installableKey, overrideRaw] of Object.entries(byKeyRaw)) {
      if (!isRecord(overrideRaw)) continue;
      const autoInstallWhenNeeded = overrideRaw.autoInstallWhenNeeded;
      const autoUpdateMode = overrideRaw.autoUpdateMode;
      Object.defineProperty(byKey, installableKey, { configurable: true, enumerable: true, writable: true, value: {
        ...(typeof autoInstallWhenNeeded === 'boolean' ? { autoInstallWhenNeeded } : {}),
        ...(autoUpdateMode === 'off' || autoUpdateMode === 'notify' || autoUpdateMode === 'auto'
          ? { autoUpdateMode }
          : {}),
      } });
    }
    Object.defineProperty(out, machineId, { configurable: true, enumerable: true, writable: true, value: byKey });
  }

  return out;
}

export function resolveInstallablePolicy(params: Readonly<{
  settings: unknown;
  machineId: string;
  installableKey: string;
  defaults: InstallableDefaultPolicy;
}>): InstallableDefaultPolicy {
  const byMachine = readInstallablesPolicyByMachineId(params.settings);
  const byKey = Object.hasOwn(byMachine, params.machineId) ? byMachine[params.machineId] : null;
  const overrides = byKey && Object.hasOwn(byKey, params.installableKey) ? byKey[params.installableKey] : null;
  if (!overrides) return params.defaults;

  return {
    autoInstallWhenNeeded:
      typeof overrides.autoInstallWhenNeeded === 'boolean'
        ? overrides.autoInstallWhenNeeded
        : params.defaults.autoInstallWhenNeeded,
    autoUpdateMode:
      overrides.autoUpdateMode === 'off' ||
      overrides.autoUpdateMode === 'notify' ||
      overrides.autoUpdateMode === 'auto'
        ? overrides.autoUpdateMode
        : params.defaults.autoUpdateMode,
  };
}

function capAutoUpdateMode(
  policyMode: InstallableAutoUpdateMode,
  sourceMode: InstallableAutoUpdateMode,
): InstallableAutoUpdateMode {
  const order: Record<InstallableAutoUpdateMode, number> = {
    off: 0,
    notify: 1,
    auto: 2,
  };
  return order[sourceMode] < order[policyMode] ? sourceMode : policyMode;
}

function applySourcePolicy(params: Readonly<{
  descriptor: InstallableDependencyDescriptor;
  policy: InstallableDefaultPolicy;
}>): InstallableDefaultPolicy {
  if (params.descriptor.source.kind !== 'managed_pypi_wheel_asset') {
    return params.policy;
  }

  return {
    autoInstallWhenNeeded:
      params.descriptor.source.installConsent === 'host_managed_required'
        ? false
        : params.policy.autoInstallWhenNeeded,
    autoUpdateMode: capAutoUpdateMode(params.policy.autoUpdateMode, params.descriptor.source.autoUpdateMode),
  };
}

export function resolveEffectiveInstallablePolicy(params: Readonly<{
  settings: unknown;
  machineId: string;
  descriptor: InstallableDependencyDescriptor;
}>): InstallableDefaultPolicy {
  return applySourcePolicy({
    descriptor: params.descriptor,
    policy: resolveInstallablePolicy({
      settings: params.settings,
      machineId: params.machineId,
      installableKey: params.descriptor.key,
      defaults: params.descriptor.defaultPolicy,
    }),
  });
}

export function applyInstallablePolicyOverride(params: Readonly<{
  prev: Record<string, Record<string, InstallablePolicyOverride>>;
  machineId: string;
  installableKey: string;
  patch: InstallablePolicyOverride;
}>): Record<string, Record<string, InstallablePolicyOverride>> {
  const prevByMachine = Object.hasOwn(params.prev, params.machineId) ? params.prev[params.machineId] : {};
  const prevOverride = Object.hasOwn(prevByMachine, params.installableKey) ? prevByMachine[params.installableKey] : {};
  return {
    ...params.prev,
    [params.machineId]: {
      ...prevByMachine,
      [params.installableKey]: {
        ...prevOverride,
        ...params.patch,
      },
    },
  };
}
