import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { formatPluginManifestIngestionDiagnostics } from '@happier-dev/protocol/plugins/manifest/ingest';
import type { PluginSourceSpecV1 } from '@happier-dev/protocol';
import { assertHostCanExcludeBundledPlugin } from '@happier-dev/cli-common/bundledPluginPublicationPolicy';
import { readCurrentBundledPluginPublicationFailures } from './publication';
export { readCurrentBundledPluginPublicationFailures, readAdmittedBundledPluginPublicationFailures } from './publication';

import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';
import { defaultCanImportFirstPartyPluginSource, isExecutingFirstPartySourceRuntime } from '@/packagedRuntime/resolvePackagedRuntimeEntrypoint';
import { readGeneratedPluginUiArtifactsManifestSync } from '@/plugins/install/ui/generatedArtifacts';
import { ingestCanonicalPluginManifest } from '../../../manifest/ingest';
import { pluginSourceProvenanceForKind } from '../../../manifest/sourceProvenance';
import type { BundledPluginPublicationFailure } from '@/plugins/validation/diagnostics/types';
import * as generatedBundledPluginManifests from '../sources/generatedBundledPluginManifests';
import { readBundledPluginManifest } from './manifestFile';
export { readBundledPluginManifest } from './manifestFile';

export type BundledPluginLocator = Readonly<{
    pluginId: string;
    manifestPath: string;
    daemonEntryPath: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec: PluginSourceSpecV1;
}> & (Readonly<{ manifestRelativePath: string }> | Readonly<{ manifest: unknown }>);

function readBundledPluginRootPath(locator: BundledPluginLocator): string {
    if (locator.sourceSpec.kind !== 'bundled' || !locator.sourceSpec.locator.trim()) {
        throw new Error(`Invalid bundled source locator for plugin '${locator.pluginId}'`);
    }
    return locator.sourceSpec.locator;
}

const requireFromCli = createRequire(import.meta.url);
function managedProviderKey(pluginId: string, providerId: string): string {
    return `${pluginId}\u0000${providerId}`;
}

function readUnavailableManagedProviderKeys(): ReadonlySet<string> {
    const packageJson = JSON.parse(readFileSync(resolveCliRuntimeAssetPath('package.json'), 'utf8')) as Readonly<{
        happier?: Readonly<{ managedRuntimePublication?: unknown }>;
    }>;
    const metadata = packageJson.happier?.managedRuntimePublication;
    // An unmaterialized source checkout has no pack claim and retains its normal
    // developer runtime. Every tarball produced by packTarball carries metadata.
    if (metadata === undefined) return new Set();
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new Error('Invalid CLI managed runtime publication metadata');
    }
    const record = metadata as Readonly<Record<string, unknown>>;
    if (
        record.v !== 1
        || (record.mode !== 'source-only' && record.mode !== 'complete')
        || !Array.isArray(record.unavailableProviderRefs)
        || Object.keys(record).sort().join(',') !== 'mode,unavailableProviderRefs,v'
    ) {
        throw new Error('Invalid CLI managed runtime publication metadata');
    }
    const keys = new Set<string>();
    for (const value of record.unavailableProviderRefs) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('Invalid CLI managed runtime publication provider reference');
        }
        const ref = value as Readonly<Record<string, unknown>>;
        const pluginId = typeof ref.pluginId === 'string' ? ref.pluginId.trim() : '';
        const providerId = typeof ref.providerId === 'string' ? ref.providerId.trim() : '';
        if (!pluginId || !providerId || Object.keys(ref).sort().join(',') !== 'pluginId,providerId') {
            throw new Error('Invalid CLI managed runtime publication provider reference');
        }
        const key = managedProviderKey(pluginId, providerId);
        if (keys.has(key)) {
            throw new Error(`Duplicate CLI managed runtime publication provider reference '${pluginId}:${providerId}'`);
        }
        keys.add(key);
    }
    if (record.mode === 'complete' && keys.size > 0) {
        throw new Error('Complete CLI managed runtime publication cannot suppress provider facets');
    }
    if (record.mode === 'source-only' && keys.size === 0) {
        throw new Error('Source-only CLI managed runtime publication must identify unavailable provider facets');
    }
    return record.mode === 'source-only' ? keys : new Set();
}

export function projectManagedRuntimePublicationManifest(
    locator: BundledPluginLocator,
    unavailableProviderKeys: ReadonlySet<string>,
    unmatchedProviderKeys: Set<string>,
): unknown {
    const declaration = readBundledPluginManifest(locator);
    if (unavailableProviderKeys.size === 0) return declaration;
    if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) {
        return declaration;
    }
    const manifest = declaration as Readonly<Record<string, unknown>>;
    const contributes = manifest.contributes;
    if (!contributes || typeof contributes !== 'object' || Array.isArray(contributes)) return declaration;
    const contributionRecord = contributes as Readonly<Record<string, unknown>>;
    if (!Array.isArray(contributionRecord.providers)) return declaration;

    let changed = false;
    const providers = contributionRecord.providers.map((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        const provider = value as Readonly<Record<string, unknown>>;
        const providerId = typeof provider.id === 'string' ? provider.id : '';
        const key = managedProviderKey(locator.pluginId, providerId);
        if (!unavailableProviderKeys.has(key) || !Object.hasOwn(provider, 'managedRuntime')) return value;
        const { managedRuntime: _unavailableManagedRuntime, ...providerWithoutManagedRuntime } = provider;
        changed = true;
        unmatchedProviderKeys.delete(key);
        return providerWithoutManagedRuntime;
    });
    if (!changed) return declaration;
    return {
        ...manifest,
        contributes: { ...contributionRecord, providers },
    };
}

function resolveInstalledBundledPluginRootPath(packageName: string): string | null {
    // Source runtime emission puts the plugin beside its CLI. Its immutable
    // graph and bytes must not come from the moving dependency symlink instead.
    if (isExecutingFirstPartySourceRuntime(import.meta.url) && packageName.startsWith('@happier-dev/plugins-')) {
        return resolveCliRuntimeAssetPath('../../packages/plugins', packageName.slice('@happier-dev/plugins-'.length));
    }
    for (const searchPath of requireFromCli.resolve.paths(packageName) ?? []) {
        const packageRootPath = join(searchPath, ...packageName.split('/'));
        if (existsSync(join(packageRootPath, 'package.json'))) {
            return packageRootPath;
        }
    }
    return null;
}

export function loadBundledPluginLocatorResult(
    locators: readonly BundledPluginLocator[],
    publicationFailures: readonly BundledPluginPublicationFailure[] = [],
): Readonly<{
    loadedPlugins: readonly LoadedPlugin[];
    pluginFailures: readonly BundledPluginPublicationFailure[];
}> {
    const seenPluginIds = new Set<string>();
    const unavailableProviderKeys = readUnavailableManagedProviderKeys();
    const unmatchedProviderKeys = new Set(unavailableProviderKeys);
    const loadedPlugins: LoadedPlugin[] = [];
    const pluginFailures = [...publicationFailures];
    const failedPluginIds = new Set(publicationFailures.map((failure) => failure.pluginId));
    for (const locator of locators) {
        if (seenPluginIds.has(locator.pluginId)) {
            throw new Error(`Duplicate bundled plugin locator '${locator.pluginId}'`);
        }
        seenPluginIds.add(locator.pluginId);
        if (failedPluginIds.has(locator.pluginId)) continue;

        try {

        const manifest = projectManagedRuntimePublicationManifest(
            locator,
            unavailableProviderKeys,
            unmatchedProviderKeys,
        );
        const ingestion = ingestCanonicalPluginManifest(manifest, {
            purpose: 'installedRead',
            manifestAuthority: 'bundled_first_party',
            sourceProvenance: pluginSourceProvenanceForKind('bundled'),
        });
        if (!ingestion.ok) {
            throw new Error(
                `Invalid bundled plugin manifest '${locator.pluginId}': ${formatPluginManifestIngestionDiagnostics(ingestion.diagnostics.map(diagnostic => ({ ...diagnostic, code: 'plugin_manifest_invalid' as const })))}`,
            );
        }
        if (ingestion.manifest.id !== locator.pluginId) {
            throw new Error(
                `Bundled plugin manifest id '${ingestion.manifest.id}' does not match '${locator.pluginId}'`,
            );
        }
        const declaredDaemon = ingestion.manifest.entrypoints?.daemon;
        if ((declaredDaemon !== undefined) !== (locator.daemonEntryPath !== null)) {
            throw new Error(
                `Bundled plugin '${locator.pluginId}' daemon locator does not match its manifest entrypoint`,
            );
        }
        const bundledPluginLocator = readBundledPluginRootPath(locator);
        const installedPluginRootPath = resolveInstalledBundledPluginRootPath(bundledPluginLocator);
        const generatedUiArtifactsManifest = installedPluginRootPath
            ? readGeneratedPluginUiArtifactsManifestSync(installedPluginRootPath)
            : null;

        loadedPlugins.push(Object.freeze({
            pluginId: locator.pluginId,
            pluginRootPath: installedPluginRootPath ?? bundledPluginLocator,
            manifestPath: locator.manifestPath,
            daemonEntryPath: locator.daemonEntryPath,
            devDaemonEntryPath: locator.devDaemonEntryPath ?? null,
            manifest: ingestion.manifest,
            sourceSpec: locator.sourceSpec,
            ...(generatedUiArtifactsManifest ? { generatedUiArtifactsManifest } : {}),
        }));
        } catch (error) {
            assertHostCanExcludeBundledPlugin('', locator.sourceSpec.locator, error);
            pluginFailures.push(Object.freeze({
                packageName: locator.sourceSpec.locator,
                pluginId: locator.pluginId,
                diagnostic: Object.freeze({
                    code: 'plugin_manifest_invalid',
                    message: error instanceof Error ? error.message : String(error),
                }),
            }));
        }
    }
    if (unmatchedProviderKeys.size > 0) {
        throw new Error(
            `CLI managed runtime publication references unknown provider facets: ${[...unmatchedProviderKeys].map((key) => key.replace('\u0000', ':')).join(', ')}`,
        );
    }
    return Object.freeze({
        loadedPlugins: Object.freeze(loadedPlugins),
        pluginFailures: Object.freeze(pluginFailures),
    });
}

export function loadBundledPluginLocators(
    locators: readonly BundledPluginLocator[],
): readonly LoadedPlugin[] {
    const result = loadBundledPluginLocatorResult(locators);
    if (result.pluginFailures.length > 0) {
        throw new Error(result.pluginFailures[0]!.diagnostic.message);
    }
    return result.loadedPlugins;
}

let admittedBundledPlugins: ReturnType<typeof loadBundledPluginLocatorResult> | null = null;

export function loadCurrentBundledPluginLocatorResult() {
    // Admit the executing closure's bundled declarations on the first catalog
    // demand. Installed-plugin discovery then reuses that graph instead of
    // rereading and validating every bundled manifest on each refresh.
    if (admittedBundledPlugins) return admittedBundledPlugins;
    // Direct TypeScript loading has no publication claim. Compiled source
    // runtimes carry their own derived declarations and failure inventory,
    // just as package runtimes carry their own publication inventory.
    return admittedBundledPlugins = loadBundledPluginLocatorResult(
        generatedBundledPluginManifests.BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS,
        defaultCanImportFirstPartyPluginSource()
            ? [] : readCurrentBundledPluginPublicationFailures(),
    );
}
