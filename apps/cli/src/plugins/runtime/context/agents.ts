import type { AgentCliReadinessService as PluginAgentCliReadinessService } from '@happier-dev/plugin-sdk/exec';

import { PluginError } from '@happier-dev/plugin-sdk';
import { probeResolvedAgentCliVersion, type RunResolvedAgentCliVersionCommand } from '@/capabilities/snapshots/cliSnapshot';
import { resolveAgentCliLaunchSpec } from '@/packagedRuntime/managedTools/requireAgentCliLaunchSpec';

export type PluginAgentCliReadinessServiceForHost = Readonly<{
    checkReadiness(
        request: Parameters<PluginAgentCliReadinessService['checkReadiness']>[0],
        options?: Readonly<{ runVersionCommand: RunResolvedAgentCliVersionCommand }>,
    ): ReturnType<PluginAgentCliReadinessService['checkReadiness']>;
}>;

export type CreatePluginAgentCliReadinessServiceParams = Readonly<{
    processEnv?: NodeJS.ProcessEnv;
}>;

function createAbortError(): Error {
    const error = new Error('Plugin agent CLI readiness check was aborted');
    error.name = 'AbortError';
    return error;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
        throw createAbortError();
    }
}

function uniqueCandidates(candidates: readonly string[]): readonly string[] {
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
        const value = candidate.trim();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        normalized.push(value);
    }
    return Object.freeze(normalized);
}

function resolveCurrentLaunchableAgentCli(agentId: string, processEnv: NodeJS.ProcessEnv) {
    try {
        return resolveAgentCliLaunchSpec(agentId, { processEnv });
    } catch {
        // An installed Agent without current runtime metadata is not launchable. Keep
        // the readiness boundary fail-closed instead of substituting another Agent.
        return null;
    }
}

export function createPluginAgentCliReadinessService(
    params: CreatePluginAgentCliReadinessServiceParams = {},
): PluginAgentCliReadinessServiceForHost {
    const processEnv = params.processEnv ?? process.env;
    return Object.freeze({
        async checkReadiness(
            request: Parameters<PluginAgentCliReadinessService['checkReadiness']>[0],
            options?: Readonly<{ runVersionCommand: RunResolvedAgentCliVersionCommand }>,
        ) {
            assertNotAborted(request.signal);
            const launchable: Array<Readonly<{ agentId: string; version?: string }>> = [];
            for (const agentId of uniqueCandidates(request.candidates)) {
                assertNotAborted(request.signal);
                const launch = resolveCurrentLaunchableAgentCli(agentId, processEnv);
                if (!launch) continue;
                if (request.includeVersion === true && !options?.runVersionCommand) {
                    throw new PluginError({
                        code: 'plugin_exec_agent_cli_version_unavailable',
                        message: 'Authorized Agent CLI version execution is unavailable',
                    });
                }
                const version = request.includeVersion === true && options?.runVersionCommand
                    ? await probeResolvedAgentCliVersion({
                        agentId,
                        launch,
                        runVersionCommand: options.runVersionCommand,
                        env: processEnv,
                        signal: request.signal,
                    })
                    : null;
                launchable.push(Object.freeze({ agentId, ...(version ? { version } : {}) }));
            }
            assertNotAborted(request.signal);
            return Object.freeze({ launchable: Object.freeze(launchable) });
        },
    });
}
