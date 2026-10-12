import { buildScopedProcessEnv, stripUnsetEnvironmentVariables } from '@/utils/processEnv/buildScopedProcessEnv';
import { resolveStackProcessKindOverrideForSessionSpawn } from './resolveStackProcessKindOverrideForSessionSpawn';
import {
  selectTrustedSessionControlEnvironment,
  stripSessionControlEnvOverrides,
} from '@/session/runtime/control/sessionControlEnvironment';
import { finalizeSessionChildEnvironment } from '@/session/runtime/control/finalizeSessionChildEnvironment';
import { withProcessOwnerEnvironment, type ProcessOwnerRef } from '@/processes/ownerTag';
import { buildToolIdleTimeoutEnvironmentOverlay, type MachineResourcesPolicyReader } from '@/processes/toolIdleTimeouts';
export function buildSpawnChildProcessEnv(params: {
  processEnv: NodeJS.ProcessEnv;
  extraEnv: Record<string, string | undefined>;
  unsetEnvKeys?: readonly string[];
  processOwner?: ProcessOwnerRef;
  happierHomeDir?: string;
  readMachineResourcesPolicy?: MachineResourcesPolicyReader;
}): Record<string, string> {
  const env = buildScopedProcessEnv({
    baseEnv: stripSessionControlEnvOverrides(params.processEnv),
    explicitEnv: params.extraEnv,
    unsetEnvKeys: params.unsetEnvKeys,
  });
  // Older daemons stamped children with their process incarnation. A surviving
  // runner is authorized by current session/account truth, never by its launcher.
  delete env.HAPPIER_DAEMON_EXECUTION_GENERATION_V1;

  const stackProcessKindOverride = resolveStackProcessKindOverrideForSessionSpawn(params.processEnv);
  const finalized = finalizeSessionChildEnvironment({
    environment: env,
    canonicalSessionControlEnvironment: selectTrustedSessionControlEnvironment(params.extraEnv),
    enableCgroupSelfMigration:
      String(params.processEnv.HAPPIER_DAEMON_STARTUP_SOURCE ?? '').trim() === 'background-service',
    stackProcessKind:
      stackProcessKindOverride.HAPPIER_STACK_PROCESS_KIND === 'session' ? 'session' : null,
  });
  const withIdlePolicy = params.readMachineResourcesPolicy ? {
    ...finalized,
    ...buildToolIdleTimeoutEnvironmentOverlay({
      environment: finalized,
      policy: params.readMachineResourcesPolicy(),
      unsetEnvKeys: params.unsetEnvKeys,
    }),
  } : finalized;
  // Scoped environments already omit undefined values. Preserve that launch
  // contract after finalization and ownership stamping, rather than widening
  // their type back to the ambient process environment.
  return stripUnsetEnvironmentVariables(
    params.processOwner ? withProcessOwnerEnvironment(withIdlePolicy, params.processOwner, params.happierHomeDir) : withIdlePolicy,
    undefined,
  );
}
