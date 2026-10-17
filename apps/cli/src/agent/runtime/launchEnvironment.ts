import { AgentLaunchEnvironmentV1Schema } from '@happier-dev/protocol/runtime/agentSessionV1';
import type { AgentLaunchEnvironment } from '@happier-dev/plugin-sdk/agents/runtime';

import { buildScopedProcessEnv, normalizeUnsetEnvKeys } from '@/utils/processEnv/buildScopedProcessEnv';

/** Preserve native command lookup without inheriting host credentials or controls. */
export function resolveNativeAgentLaunchEnvironment(input: Readonly<{
    processEnv: Readonly<NodeJS.ProcessEnv>;
    environmentVariables?: Readonly<Record<string, string>>;
    unsetEnvironmentVariables?: readonly string[];
    platform?: NodeJS.Platform;
}>): AgentLaunchEnvironment {
    const platform = input.platform ?? process.platform;
    const commandSearchEnvironment = Object.fromEntries(Object.entries(input.processEnv).filter(([key]) => (
        platform === 'win32'
            ? key.toUpperCase() === 'PATH' || key.toUpperCase() === 'PATHEXT'
            : key === 'PATH'
    )));
    const unset = normalizeUnsetEnvKeys(input.unsetEnvironmentVariables);
    return AgentLaunchEnvironmentV1Schema.parse({
        values: buildScopedProcessEnv({
            baseEnv: commandSearchEnvironment,
            explicitEnv: input.environmentVariables,
            unsetEnvKeys: unset,
            platform,
        }),
        unset,
    });
}
