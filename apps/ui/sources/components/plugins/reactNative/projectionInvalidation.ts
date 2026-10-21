import {
    derivePluginReactNativeBundleCacheKey,
    getInstalledPluginReactNativeBundleCache,
    type PluginReactNativeBundleCache,
    type PluginReactNativeBundleCacheIdentity,
} from './bundleCache';
import {
    getInstalledPluginReactNativeModuleRegistry,
    type PluginReactNativeModuleRegistry,
} from './moduleRegistry';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import {
    readPluginUiReactNativeBundleCacheIdentity,
} from '@/sync/domains/plugins/ui/artifactAdoption';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { PluginUiArtifactsManifestEntryV2Schema } from '@happier-dev/protocol/plugins/ui';

export type PluginUiReactNativeRuntimeProjectionReconcilerTargets = Readonly<{
    cache: Pick<PluginReactNativeBundleCache, 'reconcileActiveProjectionIdentities'>;
    surfaceModules: Pick<PluginReactNativeModuleRegistry, 'reconcileActiveCacheKeys'>;
}>;

export type PluginUiReactNativeRuntimeProjectionSourceInput = Readonly<{
    projection: PluginUiProjectionModel | null;
    /** The captured Account lifetime which admitted this scoped projection. */
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    /** The request/currentness owner decides whether this snapshot remains live. */
    isCurrent: () => boolean;
}>;

export type PluginUiReactNativeRuntimeProjectionSource = Readonly<{
    update: (input: PluginUiReactNativeRuntimeProjectionSourceInput) => void;
    dispose: () => void;
}>;

export type PluginUiReactNativeRuntimeProjectionReconciler = Readonly<{
    createSource: () => PluginUiReactNativeRuntimeProjectionSource;
}>;

type SourceSnapshot = PluginUiReactNativeRuntimeProjectionSourceInput;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function readNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function isCurrentSnapshot(snapshot: SourceSnapshot): boolean {
    try {
        return snapshot.projection !== null
            && snapshot.isCurrent()
            && (snapshot.accountLifetime?.isCurrent() ?? true);
    } catch {
        return false;
    }
}

/**
 * The projection currentness owner reports complete scoped snapshots here. This
 * existing RN invalidation owner then takes their union, so one consumer cannot
 * evict a process-global byte/module cache entry still owned by another current
 * scope. It does not decide currentness, cache identity, or Account authority.
 */
export function createPluginUiReactNativeRuntimeProjectionReconciler(
    targets: PluginUiReactNativeRuntimeProjectionReconcilerTargets,
): PluginUiReactNativeRuntimeProjectionReconciler {
    const sources = new Map<symbol, SourceSnapshot | null>();

    const reconcile = (): void => {
        const identitiesByCacheKey = new Map<string, PluginReactNativeBundleCacheIdentity>();

        for (const snapshot of sources.values()) {
            if (!snapshot || !isCurrentSnapshot(snapshot) || !snapshot.projection) continue;

            for (const bundle of Object.values(snapshot.projection.reactNativeBundlesById)) {
                const entry = readRecord(bundle);
                const runtime = readRecord(entry?.runtime);
                const decision = readRecord(runtime?.decision);
                const loadPolicy = readRecord(runtime?.loadPolicy);
                if (
                    decision?.state !== 'load'
                    || loadPolicy?.source !== 'installedArtifact'
                ) {
                    continue;
                }

                const cacheKey = readNonEmptyString(runtime?.cacheKey);
                const pluginId = readNonEmptyString(entry?.pluginId);
                const contributionId = readNonEmptyString(entry?.contributionId);
                const graph = PluginUiArtifactsManifestEntryV2Schema.safeParse(entry?.artifactGraph);
                const identity = pluginId && contributionId && graph.success && graph.data.tier === 'reactNative'
                    ? readPluginUiReactNativeBundleCacheIdentity(runtime?.cacheIdentity, {
                        pluginId,
                        contributionId,
                        artifactId: graph.data.artifactId,
                        platform: 'web',
                    })
                    : null;
                if (
                    !identity
                    || !cacheKey
                    || !pluginId
                    || !contributionId
                    || identity.pluginId !== pluginId
                    || identity.contributionId !== contributionId
                    || cacheKey !== derivePluginReactNativeBundleCacheKey(identity)
                ) {
                    continue;
                }
                identitiesByCacheKey.set(cacheKey, identity);
            }
        }

        const cacheKeys = [...identitiesByCacheKey.keys()];
        targets.cache.reconcileActiveProjectionIdentities([...identitiesByCacheKey.values()]);
        targets.surfaceModules.reconcileActiveCacheKeys(cacheKeys);
    };

    return Object.freeze({
        createSource: () => {
            const sourceId = Symbol('plugin-ui-react-native-projection-source');
            let disposed = false;
            let boundLifetime: ActiveServerAccountScopeLifetime | null = null;
            let retirement: Readonly<{ dispose: () => void }> | null = null;

            const update = (input: PluginUiReactNativeRuntimeProjectionSourceInput): void => {
                if (disposed) return;
                if (boundLifetime !== input.accountLifetime) {
                    retirement?.dispose();
                    boundLifetime = input.accountLifetime;
                    retirement = boundLifetime?.onRetire(() => {
                        if (disposed || boundLifetime !== input.accountLifetime) return;
                        sources.set(sourceId, null);
                        reconcile();
                    }) ?? null;
                }
                sources.set(sourceId, input);
                reconcile();
            };

            sources.set(sourceId, null);
            return Object.freeze({
                update,
                dispose: () => {
                    if (disposed) return;
                    disposed = true;
                    retirement?.dispose();
                    retirement = null;
                    boundLifetime = null;
                    sources.delete(sourceId);
                    reconcile();
                },
            });
        },
    });
}

const installedPluginUiReactNativeRuntimeProjectionReconciler =
    createPluginUiReactNativeRuntimeProjectionReconciler({
        cache: getInstalledPluginReactNativeBundleCache(),
        surfaceModules: getInstalledPluginReactNativeModuleRegistry(),
    });

export function createInstalledPluginUiReactNativeRuntimeProjectionSource(): PluginUiReactNativeRuntimeProjectionSource {
    return installedPluginUiReactNativeRuntimeProjectionReconciler.createSource();
}
