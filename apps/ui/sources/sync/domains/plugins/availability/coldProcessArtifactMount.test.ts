import { describe, expect, it, vi } from 'vitest';

import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

installHomeGovernanceBoundaries(createHomeGovernanceHarness());
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

import {
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
    PluginUiArtifactDigestV1Schema,
} from '@happier-dev/protocol/plugins/ui';
import {
    PluginAccountAvailabilityIntentReadResponseV1Schema,
    PluginReleaseFactsV1Schema,
    type PluginMachineMaterializationV1,
} from '@happier-dev/protocol/plugins/availability';

import { encodeBase64 } from '@/encryption/base64';
import { createPluginReactNativeBundleCache } from '@/components/plugins/reactNative/bundleCache';
import { adaptPluginUiPersistentArtifactStoreForReactNativeBundleCache } from '@/components/plugins/reactNative/bundleCache';
import { createBrowserPluginUiPersistentArtifactStore } from '@/sync/domains/plugins/ui/artifactByteCache.browser';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';

import { createPluginAccountAvailabilityReader, type PluginAccountAvailabilitySnapshot } from './reader';
const { createPluginReactNativeArtifactAvailabilityProducer } = await import('./reactNativeArtifactAvailability');

const scope = { serverId: 'server-a', accountId: 'account-a' } as const;

const accountLifetime: ActiveServerAccountScopeLifetime = Object.freeze({
    scope,
    isCurrent: () => true,
    onRetire: () => Object.freeze({ dispose: () => {} }),
});

const inactiveAppExactSource = Object.freeze({ kind: 'appExact' as const, fetch: async () => null });

/**
 * The device's persistent Artifact custody survives a process restart. This
 * fake is the storage boundary only: every reader, integrity check, cache and
 * lease below is the real implementation.
 */
function createDurableCacheStorage(): CacheStorage {
    const stores = new Map<string, Map<string, Response>>();
    const requestUrl = (request: RequestInfo | URL): string => {
        if (typeof request === 'string') return request;
        return request instanceof URL ? request.href : request.url;
    };
    return {
        open: async (name) => {
            const records = stores.get(name) ?? new Map<string, Response>();
            stores.set(name, records);
            return {
                match: async (request: RequestInfo | URL) => records.get(requestUrl(request))?.clone(),
                put: async (request: RequestInfo | URL, response: Response) => {
                    records.set(requestUrl(request), response.clone());
                },
                delete: async (request: RequestInfo | URL) => records.delete(requestUrl(request)),
                keys: async () => [...records.keys()].map((url) => new Request(url)),
            } as unknown as Cache;
        },
        delete: async (name) => stores.delete(name),
        has: async (name) => stores.has(name),
        keys: async () => [...stores.keys()],
        match: async () => undefined,
    };
}

function fixture() {
    const artifactContributionId = 'native-preview';
    const artifactId = 'native-preview-artifact';
    const entryPath = `react-native/${artifactId}/entry.cjs.bundle`;
    const entryBytes = new TextEncoder().encode('// entry bundle bytes');
    const files = [
        {
            relativePath: entryPath,
            digest: computePluginUiArtifactSha256DigestV1(entryBytes),
            byteSize: entryBytes.byteLength,
        },
    ] as const;
    const artifactDigest = computePluginUiArtifactFileSetSha256DigestV1([
        { relativePath: entryPath, bytes: entryBytes },
    ]);
    const archiveDigestSha256 = PluginUiArtifactDigestV1Schema.parse(`sha256:${'a'.repeat(64)}`);
    const release = PluginReleaseFactsV1Schema.parse({
        ref: { pluginId: 'com.acme.preview', version: '1.2.3' },
        archiveDigestSha256,
        normalizedManifest: {
            schemaVersion: 2,
            id: 'com.acme.preview',
            version: '1.2.3',
            displayName: 'Acme preview',
            engines: { happier: '^1.0.0' },
            runtime: { apiVersion: 1 },
            contributes: {},
        },
        collectionContracts: [],
        uiSlots: [{
            contributionId: artifactContributionId,
            artifactId,
            tier: 'reactNative',
            platform: 'ios',
            artifactDigest,
            hostUiApiRange: '^1.0.0',
        }],
        packageAssetArchive: { archiveDigestSha256: `sha256:${'d'.repeat(64)}`, resources: [] },
    });
    const materialization: PluginMachineMaterializationV1 = {
        serverIdentityId: 'srv_account_one',
        machineId: 'machine-a',
        materializationId: 'install-epoch-a',
        pluginId: 'com.acme.preview',
        version: '1.2.3',
        sourceClass: 'versionedArchive',
        portableRelease: true,
        archiveDigestSha256,
        uiArtifacts: [{
            contributionId: artifactContributionId,
            artifactId,
            tier: 'reactNative',
            platform: 'ios',
            artifactDigest,
            hostUiApiRange: '^1.0.0',
        }],
        enabled: true,
        trustState: 'trusted',
        observedAt: 1,
    };
    // Account Availability is read from the SERVER over the closed Availability
    // HTTP family, not from a daemon. A cold process with an unreachable daemon
    // still resolves this projection.
    const snapshot = {
        availabilityCursor: 7,
        intentReads: [{
            pluginId: materialization.pluginId,
            response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
                availabilityCursor: 7,
                packageAssets: [],
                hostingCapability: { enabled: false },
                intent: {
                    pluginId: materialization.pluginId,
                    desiredVersion: materialization.version,
                    enabled: true,
                    offlineUiHosting: 'disabled',
                    writableCollections: [],
                    revision: 'intent-1',
                },
                release,
                uiArtifacts: [],
            }),
        }],
        materializations: [materialization],
        snapshots: [{
            serverIdentityId: materialization.serverIdentityId,
            machineId: materialization.machineId,
            materializations: [materialization],
        }],
    } satisfies PluginAccountAvailabilitySnapshot;
    const reader = createPluginAccountAvailabilityReader({ scope, snapshot });
    const cacheIdentity = {
        pluginId: materialization.pluginId,
        contributionId: artifactContributionId,
        artifactId,
        artifactDigest,
        platform: 'ios' as const,
    } satisfies PluginReactNativeBundleCacheIdentity;
    const artifactGraph = {
        artifactId,
        tier: 'reactNative' as const,
        entry: entryPath,
        files,
        digest: artifactDigest,
        builtWith: { bundler: 'esbuild' as const, version: '0.25.0' },
        executable: { exports: ['renderSurface'] as const },
        hostUiApiRange: '^1.0.0',
    };
    const origin = {
        serverIdentityId: materialization.serverIdentityId,
        materializationRef: {
            machineId: materialization.machineId,
            materializationId: materialization.materializationId,
            pluginId: materialization.pluginId,
        },
    } as const;
    const daemonResponse = {
        ok: true as const,
        artifactFamily: 'reactNative' as const,
       
        cacheIdentity: { artifactDigest },
        artifact: {
            artifactKind: 'reactNativeBundle' as const,
            digest: artifactDigest,
            format: 'plainJs' as const,
            byteSize: entryBytes.byteLength,
        },
        bytesBase64: encodeBase64(entryBytes),
        files: [
            { ...files[0], bytesBase64: encodeBase64(entryBytes) },
        ],
    };
    return { reader, cacheIdentity, artifactGraph, origin, daemonResponse };
}

describe('cold process Artifact mount with every daemon unreachable', () => {
    it('mounts Account-qualified bytes from device custody and refuses once that custody is empty', async () => {
        const current = fixture();
        const cacheStorage = createDurableCacheStorage();
        const browserStore = createBrowserPluginUiPersistentArtifactStore(cacheStorage);
        // The browser tier reaches the RN bundle cache through the same
        // canonical adaptation `createDefaultPersistentArtifactStore` uses.
        const persistentStore = adaptPluginUiPersistentArtifactStoreForReactNativeBundleCache(browserStore);

        // Warm run: a reachable daemon supplies the bytes once, and the
        // Account-qualified custody keeps them on the device.
        const warmProducer = createPluginReactNativeArtifactAvailabilityProducer({
            getCache: () => createPluginReactNativeBundleCache({ persistentStore }),
            appExact: inactiveAppExactSource,
            fetchDaemonArtifactBytes: async () => current.daemonResponse,
        });
        const warm = await warmProducer.acquire({
            reader: current.reader,
            artifactGraph: current.artifactGraph,
            cacheIdentity: current.cacheIdentity,
            accountLifetime,
            daemon: { machineId: current.origin.materializationRef.machineId, serverId: scope.serverId },
            isCurrent: () => true,
        });
        expect(warm.kind).toBe('available');

        // Cold process: a brand new in-memory cache, no daemon route at all,
        // and a daemon fetcher that fails loudly if anything reaches for it.
        // The journey is "laptop asleep, phone on cellular": every daemon is
        // unreachable while the server still answers Account Availability.
        const coldDaemonFetch = vi.fn(async () => {
            throw new Error('a cold process must not need a daemon to mount');
        });
        const coldProducer = createPluginReactNativeArtifactAvailabilityProducer({
            getCache: () => createPluginReactNativeBundleCache({ persistentStore }),
            appExact: inactiveAppExactSource,
            fetchDaemonArtifactBytes: coldDaemonFetch,
        });
        const cold = await coldProducer.acquire({
            reader: current.reader,
            artifactGraph: current.artifactGraph,
            cacheIdentity: current.cacheIdentity,
            accountLifetime,
            isCurrent: () => true,
        });
        expect(cold.kind).toBe('available');
        expect(coldDaemonFetch).not.toHaveBeenCalled();

        // Falsification: empty the device custody for this Account and the same
        // cold process must fail closed instead of mounting anything.
        await browserStore.removeAccount(scope);
        const emptied = await coldProducer.acquire({
            reader: current.reader,
            artifactGraph: current.artifactGraph,
            cacheIdentity: current.cacheIdentity,
            accountLifetime,
            isCurrent: () => true,
        });
        expect(emptied).toMatchObject({ kind: 'unavailable', code: 'artifact_source_unavailable' });
        expect(coldDaemonFetch).not.toHaveBeenCalled();
    });
});
