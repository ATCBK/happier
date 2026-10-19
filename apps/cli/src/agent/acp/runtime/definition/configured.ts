import type { ResolvedConfiguredAcpBackend } from '@/agent/acp/catalog/configured/resolveBackend';
import type { AcpLaunchResolution } from '@/agent/acp/catalog/configured/resolveAcpLaunch';

import type {
  AcpRuntimeDefinitionInit,
  AcpRuntimeDefinition,
} from './_types';
import { createAcpRuntimeDefinition } from './create';

type ConfiguredSupportFlag = boolean | 'yes' | 'no' | 'unknown';

export function configuredAcpRuntimeConfiguration(backend: ResolvedConfiguredAcpBackend) {
  return {
    mcp: { policy: 'pass_through' as const },
    ...(backend.runtime?.stderrRules ? { stderrRules: backend.runtime.stderrRules } : {}),
    ...(backend.runtime?.permissionModeMapping ? { permissionModeMapping: backend.runtime.permissionModeMapping } : {}),
  };
}

function normalizeSupportFlag(value: ConfiguredSupportFlag | undefined): boolean | 'unknown' | undefined {
  if (value === true || value === 'yes') {
    return true;
  }
  if (value === false || value === 'no') {
    return false;
  }
  return value;
}

function buildConfiguredDefinitionInit(params: Readonly<{
  backend: ResolvedConfiguredAcpBackend;
  launch: Extract<AcpLaunchResolution, { kind: 'ready' }>;
  launchEnv?: Readonly<Record<string, string>>;
}>): AcpRuntimeDefinitionInit {
  const capabilities = params.backend.capabilities;
  return {
    backendId: params.backend.backendId,
    source: { kind: 'account_configured' },
    identity: {
      backendId: params.backend.backendId,
    },
    ux: {
      name: params.backend.name,
      title: params.backend.title,
      ...(params.backend.description ? { description: params.backend.description } : {}),
      ...(params.backend.defaultMode ? { defaultMode: params.backend.defaultMode } : {}),
      ...(params.backend.defaultModel ? { defaultModel: params.backend.defaultModel } : {}),
    },
    transport: {
      kind: 'stdio',
      launch: {
        kind: 'executable',
        command: params.launch.command,
        args: [...params.launch.args],
        ...(params.launch.runtimeEnv ? { env: params.launch.runtimeEnv } : {}),
      },
    },
    launchEnv: { ...params.launch.env, ...params.launchEnv },
    capabilities: {
      supportsResume: capabilities.supportsLoadSession,
      supportsModes: normalizeSupportFlag(capabilities.supportsModes),
      supportsModels: normalizeSupportFlag(capabilities.supportsModels),
      supportsConfigOptions: normalizeSupportFlag(capabilities.supportsConfigOptions),
      supportsPromptImages: normalizeSupportFlag(capabilities.promptImageSupport),
      promptImageSupport: capabilities.promptImageSupport,
      supportsToolUse: true,
      supportsPermissionRequests: true,
    },
    ...configuredAcpRuntimeConfiguration(params.backend),
  };
}

export function normalizeConfiguredAcpDefinition(params: Readonly<{
  backend: ResolvedConfiguredAcpBackend;
  launch: Extract<AcpLaunchResolution, { kind: 'ready' }>;
  launchEnv?: Readonly<Record<string, string>>;
}>): AcpRuntimeDefinition {
  return createAcpRuntimeDefinition(buildConfiguredDefinitionInit(params));
}
