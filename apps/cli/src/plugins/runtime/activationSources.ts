import type { PluginSourceTrustPolicyV1 } from '@happier-dev/protocol';
import type { PluginRuntimeSourceAuthority } from './sourceAuthority';

export type PluginRelativeModuleResolution<TModule> = Readonly<{
    module: TModule;
    normalizedModulePath: string;
    loadMode: 'immutable-js' | 'source-ts';
}>;

export type PluginRelativeModuleResolver<TModule> = (
    module: string,
) => Promise<PluginRelativeModuleResolution<TModule>>;

export type ValidatedAgentSessionRunnerFactoryFactV1 = Readonly<{
    localAgentId: string;
    locator: Readonly<{
        module: string;
        export: string;
        runtimeApiVersion: 1;
        externalSessionsExport?: string;
    }>;
    normalizedModulePath: string;
    loadMode: 'immutable-js' | 'source-ts';
}>;

/**
 * The committed managed generation selected for this load. Trust and
 * currentness were decided when the store committed the generation (apply
 * time); loading does not re-verify them.
 */
export type CommittedPluginExecutionAuthorization = Readonly<{
    pluginId: string;
    immutableGenerationId: string;
}>;

/** Exact executable selection already admitted by the daemon, for its child host. */
export type PluginActivationProcessEntry = Readonly<{
    entryPath: string;
    rootPath: string;
    loadMode: 'immutable-js' | 'source-ts';
}>;

export type FileBackedPluginActivationSource = Readonly<{
    kind: 'file_backed';
    sourceAuthority?: PluginRuntimeSourceAuthority;
    entryPath: string;
    devEntryPath?: string | null;
    useDevelopmentEntry?: boolean;
    trustPolicy?: PluginSourceTrustPolicyV1;
    committedAuthorization?: CommittedPluginExecutionAuthorization;
    generationScope?: object;
    resolveRelativeModule?: PluginRelativeModuleResolver<Record<string, unknown>>;
    persistValidatedAgentSessionRunnerFactories?: (
        facts: readonly ValidatedAgentSessionRunnerFactoryFactV1[],
        options: Readonly<{ assertCurrent: () => void }>,
    ) => Promise<readonly ValidatedAgentSessionRunnerFactoryFactV1[] | void>;
}>;

export type BundledPluginActivationSource<TModule> = Readonly<{
    kind: 'bundled';
    processEntry?: PluginActivationProcessEntry;
    sourceAuthority?: PluginRuntimeSourceAuthority;
    /**
     * Stable identity for caching/diagnostics. In PS-04 this should come from the
     * generated bundled entry map (for example a package subpath).
     */
    moduleId: string;
    /**
     * Optional retry-safe work that must complete before module top-level code
     * can execute. Activation lifecycle owners may retry this phase without
     * risking duplicate module or activate() side effects.
     */
    prepare?: () => Promise<void>;
    load: () => Promise<TModule>;
    resolveRelativeModule?: PluginRelativeModuleResolver<Record<string, unknown>>;
    persistValidatedAgentSessionRunnerFactories?: (
        facts: readonly ValidatedAgentSessionRunnerFactoryFactV1[],
        options: Readonly<{ assertCurrent: () => void }>,
    ) => Promise<readonly ValidatedAgentSessionRunnerFactoryFactV1[] | void>;
}>;

export type PreparedPluginActivationSource<TModule> = Readonly<{
    kind: 'prepared';
    processEntry?: PluginActivationProcessEntry;
    sourceAuthority?: PluginRuntimeSourceAuthority;
    module: TModule;
    committedAuthorization?: CommittedPluginExecutionAuthorization;
    resolveRelativeModule?: PluginRelativeModuleResolver<Record<string, unknown>>;
    persistValidatedAgentSessionRunnerFactories?: (
        facts: readonly ValidatedAgentSessionRunnerFactoryFactV1[],
        options: Readonly<{ assertCurrent: () => void }>,
    ) => Promise<readonly ValidatedAgentSessionRunnerFactoryFactV1[] | void>;
}>;

export type PluginActivationSource<TModule> =
    | FileBackedPluginActivationSource
    | BundledPluginActivationSource<TModule>
    | PreparedPluginActivationSource<TModule>;
