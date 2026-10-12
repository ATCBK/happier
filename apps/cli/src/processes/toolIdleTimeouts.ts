import type { MachineResourcesPolicyGetResultV1 } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';
import { createAllowedEnvKeySet, isAllowedEnvKey } from '@/utils/env/envKeyAllowlist';

/** Documented tool variables, inherited by any tool the Agent starts. Values are milliseconds. */
const TOOL_IDLE_TIMEOUTS = [{ tool: 'agent-browser', environmentKey: 'AGENT_BROWSER_IDLE_TIMEOUT_MS' }] as const;

export type MachineResourcesPolicyReader = () => MachineResourcesPolicyGetResultV1;

export function buildToolIdleTimeoutEnvironmentOverlay(input: Readonly<{
  environment: NodeJS.ProcessEnv;
  policy: MachineResourcesPolicyGetResultV1;
  unsetEnvKeys?: readonly string[];
  platform?: NodeJS.Platform;
}>): Record<string, string> {
  const overlay: Record<string, string> = {};
  if (input.policy.status !== 'ready' || input.policy.policy.processes.toolIdleCloseMs === null) return overlay;
  const platform = input.platform ?? process.platform;
  for (const { environmentKey } of TOOL_IDLE_TIMEOUTS) {
    const matchingKeys = createAllowedEnvKeySet([environmentKey], platform);
    const explicitlySet = Object.entries(input.environment).some(([key, value]) =>
      typeof value === 'string' && isAllowedEnvKey(key, matchingKeys, platform));
    const explicitlyUnset = input.unsetEnvKeys?.some(key => isAllowedEnvKey(key, matchingKeys, platform));
    if (!explicitlySet && !explicitlyUnset) overlay[environmentKey] = String(input.policy.policy.processes.toolIdleCloseMs);
  }
  return overlay;
}
