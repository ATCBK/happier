import type { PluginReactNativeSurfaceModule } from './PluginReactNativeSurface';
import { instantiatePluginUiCommonJsBundle, type PluginUiCommonJsModule } from './commonJsEvaluator';

/**
 * An active-projection admission captured before an asynchronous module load.
 * The registry retains the token only while this exact cache key is current.
 */
export type PluginReactNativeModuleRegistryWriteFence = Readonly<{
    cacheKey: string;
    activeKeyToken: symbol;
}>;

export type PluginReactNativeModuleRegistry = Readonly<{
    /** Retain evaluation only for a caller's exact authority/activation scope. */
    loadExecutableExport: (
        input: Omit<Parameters<typeof instantiatePluginUiCommonJsBundle>[0], 'hostModules'> & Readonly<{
            evaluationScopeKey?: string;
        }>,
    ) => (...args: never[]) => unknown;
    read: (cacheKey: string | undefined) => PluginReactNativeSurfaceModule | null;
    /** Capture the key-local admission fact before beginning asynchronous work. */
    captureWriteFence: (cacheKey: string | undefined) => PluginReactNativeModuleRegistryWriteFence | null;
    /** Rejects a load that settled after its key's active projection retired. */
    write: (
        cacheKey: string | undefined,
        module: PluginReactNativeSurfaceModule,
        fence: PluginReactNativeModuleRegistryWriteFence,
    ) => boolean;
    /** Retain loaded modules only while an active scoped projection owns their key. */
    reconcileActiveCacheKeys: (cacheKeys: readonly string[]) => void;
}>;

export function createPluginReactNativeModuleRegistry(): PluginReactNativeModuleRegistry {
    const modules = new Map<string, PluginReactNativeSurfaceModule>();
    const executableModules = new Map<string, PluginUiCommonJsModule>();
    const activeKeyTokens = new Map<string, symbol>();
    return Object.freeze({
        loadExecutableExport: (input) => {
            // A plugin may capture its activation API in module-level state.
            // Unscoped loads retain the evaluator's fresh-namespace semantics.
            if (input.evaluationScopeKey === undefined) {
                return instantiatePluginUiCommonJsBundle(input).readExport(input.requestedExport);
            }
            const key = JSON.stringify([input.identity.pluginId, input.identity.artifactId,
                input.identity.digest, input.evaluationScopeKey]);
            let module = executableModules.get(key);
            if (!module) {
                module = instantiatePluginUiCommonJsBundle(input);
                executableModules.set(key, module);
            }
            return module.readExport(input.requestedExport);
        },
        read: (cacheKey) => cacheKey ? modules.get(cacheKey) ?? null : null,
        captureWriteFence: (cacheKey) => {
            if (!cacheKey) return null;
            const activeKeyToken = activeKeyTokens.get(cacheKey);
            return activeKeyToken
                ? Object.freeze({ cacheKey, activeKeyToken })
                : null;
        },
        write: (cacheKey, module, fence) => {
            if (
                !cacheKey
                || fence.cacheKey !== cacheKey
                || activeKeyTokens.get(cacheKey) !== fence.activeKeyToken
            ) {
                return false;
            }
            modules.set(cacheKey, module);
            return true;
        },
        reconcileActiveCacheKeys: (cacheKeys) => {
            const nextActiveKeyTokens = new Map<string, symbol>();
            for (const cacheKey of cacheKeys) {
                nextActiveKeyTokens.set(
                    cacheKey,
                    activeKeyTokens.get(cacheKey) ?? Symbol('plugin-ui-react-native-active-cache-key'),
                );
            }
            activeKeyTokens.clear();
            for (const [cacheKey, activeKeyToken] of nextActiveKeyTokens) {
                activeKeyTokens.set(cacheKey, activeKeyToken);
            }
            for (const cacheKey of modules.keys()) {
                if (!activeKeyTokens.has(cacheKey)) {
                    modules.delete(cacheKey);
                }
            }
        },
    });
}

const installedPluginReactNativeModuleRegistry = createPluginReactNativeModuleRegistry();

export function getInstalledPluginReactNativeModuleRegistry(): PluginReactNativeModuleRegistry {
    return installedPluginReactNativeModuleRegistry;
}
