import type { PluginAgentCliMetadata } from '@happier-dev/protocol';
import type { AgentCliRuntimeDescriptor } from '@happier-dev/cli-common/agents';
import { readAgentCommandTitle } from './agentCommandTitle';

export function projectNativeAgentCliRuntimeDescriptor(params: Readonly<{ agentId: string; title: unknown; cli: PluginAgentCliMetadata }>): AgentCliRuntimeDescriptor {
    const { executable, install } = params.cli;
    const manualInstallRecipes = install.manual.kind === 'none' ? null : (install.manual.recipes ?? null);
    return Object.freeze({
        id: params.agentId,
        title: readAgentCommandTitle(params),
        binaryName: executable.binaryName,
        ...(executable.alternativeBinaryNames ? { alternativeBinaryNames: Object.freeze([...executable.alternativeBinaryNames]) } : {}),
        ...(executable.alternativeBinaryFallbackEnabledEnvVar ? { alternativeBinaryFallbackEnabledEnvVar: executable.alternativeBinaryFallbackEnabledEnvVar } : {}),
        ...(executable.knownUserBinDirSuffixes === null ? { knownUserBinDirSuffixes: null } : executable.knownUserBinDirSuffixes ? { knownUserBinDirSuffixes: Object.freeze([...executable.knownUserBinDirSuffixes]) } : {}),
        ...(executable.knownEnvironmentBinDirs ? { knownEnvironmentBinDirs: Object.freeze(executable.knownEnvironmentBinDirs.map((directory) => Object.freeze({ ...directory }))) } : {}),
        ...(executable.systemCommandResolutionStrategy ? { systemCommandResolutionStrategy: executable.systemCommandResolutionStrategy } : {}),
        sourcePreferenceDefault: executable.sourcePreference,
        managedInstall: install.managed ?? null,
        manualInstallKind: install.manual.kind,
        manualInstallRecipes,
        acceptsJavaScriptFileOverride: executable.acceptsJavaScriptFileOverride ?? false,
        ...(install.recommendationOrder !== undefined ? { setupRecommendation: Object.freeze({ order: install.recommendationOrder }) } : {}),
        ...(install.guideUrl !== undefined ? { installGuideUrl: install.guideUrl } : {}),
        ...(install.docsUrl !== undefined ? { docsUrl: install.docsUrl } : {}),
        ...(install.npmPackageName !== undefined ? { npmPackageName: install.npmPackageName } : {}),
        ...(install.nativeUpdate !== undefined ? { nativeUpdate: install.nativeUpdate === null ? null : Object.freeze({ args: Object.freeze([...install.nativeUpdate.args]), installPaths: Object.freeze([...install.nativeUpdate.installPaths]) }) } : {}),
    });
}
