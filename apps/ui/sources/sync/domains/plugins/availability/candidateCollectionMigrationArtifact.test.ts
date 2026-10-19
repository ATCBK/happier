import { describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

import {
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
} from '@happier-dev/protocol/plugins/ui';
import { PluginReleaseFactsV1Schema } from '@happier-dev/protocol/plugins/availability';
import type { PluginArtifactSourceCandidate } from './artifactLease';
import {
    createPluginReactNativeArtifactLeaseCacheSink,
    createPluginReactNativeBundleCache,
} from '@/components/plugins/reactNative/bundleCache';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';
import type { ActivePluginAccountHostedArtifactReader } from '@/sync/api/plugins/availability/activePluginAccountHostedArtifactRead';

installHomeGovernanceBoundaries(createHomeGovernanceHarness());
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const {
    createCandidatePluginCollectionMigrationArtifactLoader,
    resolveCandidatePluginCollectionMigrationArtifactAccountHostedTarget,
} = await import('./candidateCollectionMigrationArtifact');

vi.mock('./generatedBundledPluginUiArtifacts', () => ({
    BUNDLED_PLUGIN_UI_APP_ARTIFACTS: Object.freeze([]),
}));

const pluginId = 'example.tasks';
const releaseVersion = '2.0.0';
const artifactId = 'tasks-ui';
const entryPath = `react-native/${artifactId}/entry.cjs.bundle`;
const entryBytes = new TextEncoder().encode('// candidate migration bundle');
const entryDigest = computePluginUiArtifactSha256DigestV1(entryBytes);
const artifactDigest = computePluginUiArtifactFileSetSha256DigestV1([
    { relativePath: entryPath, bytes: entryBytes },
]);

const accountLifetime = Object.freeze({
    scope: Object.freeze({ serverId: 'server-a', accountId: 'account-a' }),
    isCurrent: () => true,
    onRetire: () => Object.freeze({ dispose: () => {} }),
});

const cacheIdentity: PluginReactNativeBundleCacheIdentity = Object.freeze({
    pluginId,
    contributionId: 'tasks',
    artifactId,
    artifactDigest,
    platform: 'ios',
});

const graph = Object.freeze({
    artifactId,
    tier: 'reactNative' as const,
    entry: entryPath,
    files: [{ relativePath: entryPath, digest: entryDigest, byteSize: entryBytes.byteLength }],
    digest: artifactDigest,
    builtWith: { bundler: 'esbuild' as const, version: '0.27.2' },
    executable: { exports: ['collectionMigrations', 'renderSurface'] },
    hostUiApiRange: '^1.0.0',
});

const manifest = Object.freeze({
    schemaVersion: 2,
    id: pluginId,
    version: releaseVersion,
    displayName: 'Example tasks',
    engines: { happier: '^1.0.0' },
    runtime: { apiVersion: 1 },
    contributes: {
        accountCollections: [{
            id: 'tasks',
            schemaVersion: 2,
            schema: {
                type: 'object',
                properties: {
                    id: { type: 'string', maxLength: 256 },
                    migrated: { type: 'boolean' },
                },
                required: ['id', 'migrated'],
                additionalProperties: false,
            },
            rowIdField: 'id',
            serverReadable: ['id', 'migrated'],
            indexes: [],
            uiQueries: [],
            relations: [],
            readableSchemaVersions: [1],
            migrations: [{
                id: 'upgrade-v1-to-v2',
                fromSchemaVersion: 1,
                toSchemaVersion: 2,
            }],
            migrationArtifact: {
                artifactId,
                exportName: 'collectionMigrations',
            },
        }],
    },
});

const targetFacts = PluginReleaseFactsV1Schema.parse({
    ref: { pluginId, version: releaseVersion },
    archiveDigestSha256: `sha256:${'e'.repeat(64)}`,
    normalizedManifest: manifest,
    collectionContracts: [],
    uiSlots: [{
        contributionId: 'tasks',
        artifactId: graph.artifactId,
        tier: graph.tier,
        platform: 'ios',
        artifactDigest: graph.digest,
        hostUiApiRange: graph.hostUiApiRange,
    }],
    packageAssetArchive: {
        archiveDigestSha256: `sha256:${'f'.repeat(64)}`,
        resources: [],
    },
});

function createAppExact(): PluginArtifactSourceCandidate & Readonly<{ kind: 'appExact' }> {
    return Object.freeze({
        kind: 'appExact' as const,
        fetch: async () => new Map([[entryPath, new Uint8Array(entryBytes)]]),
    });
}

describe('candidate Collection migration Artifact loader', () => {
    it('derives one exact prospective Account-hosted target input without a daemon projection', async () => {
        const reader = {
            readTarget: vi.fn(async () => Object.freeze({
                kind: 'available' as const,
                value: Object.freeze({
                    link: Object.freeze({
                        release: targetFacts.ref,
                        contributionId: 'tasks',
                        artifactId: graph.artifactId,
                        tier: graph.tier,
                        platform: 'ios',
                        accountArtifactId: '00000000-0000-4000-8000-000000000001',
                        artifactDigest: graph.digest,
                        hostUiApiRange: graph.hostUiApiRange,
                    }),
                    archive: Object.freeze({ artifactGraph: graph }),
                }),
            })),
        } as unknown as ActivePluginAccountHostedArtifactReader;

        const result = await resolveCandidatePluginCollectionMigrationArtifactAccountHostedTarget({
            accountLifetime,
            isCurrent: () => true,
            facts: targetFacts,
            reader,
        });

        expect(result).toMatchObject({
            kind: 'available',
            candidateTarget: {
                release: targetFacts.ref,
                artifact: {
                    contributionId: 'tasks',
                    artifactId: graph.artifactId,
                    platform: 'ios',
                    digest: graph.digest,
                    hostUiApiRange: graph.hostUiApiRange,
                },
            },
            artifact: {
                artifactGraph: graph,
                cacheIdentity: {
                    pluginId,
                    contributionId: 'tasks',
                    artifactId: graph.artifactId,
                    artifactDigest: graph.digest,
                    platform: 'ios',
                },
                accountHosted: {},
            },
        });
        expect((reader.readTarget as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith({
            accountLifetime,
            release: targetFacts.ref,
            slot: {
                contributionId: 'tasks',
                artifactId: graph.artifactId,
                tier: graph.tier,
                platform: 'ios',
            },
            expectedArtifactDigest: graph.digest,
        });
    });

    it('rejects an Account-hosted target whose host API range differs from its release slot', async () => {
        const incompatibleGraph = Object.freeze({
            ...graph,
            hostUiApiRange: '^2.0.0',
        });
        const reader = {
            readTarget: vi.fn(async () => Object.freeze({
                kind: 'available' as const,
                value: Object.freeze({
                    link: Object.freeze({
                        release: targetFacts.ref,
                        contributionId: 'tasks',
                        artifactId: incompatibleGraph.artifactId,
                        tier: incompatibleGraph.tier,
                        platform: 'ios',
                        accountArtifactId: '00000000-0000-4000-8000-000000000001',
                        artifactDigest: incompatibleGraph.digest,
                        hostUiApiRange: incompatibleGraph.hostUiApiRange,
                    }),
                    archive: Object.freeze({ artifactGraph: incompatibleGraph }),
                }),
            })),
        } as unknown as ActivePluginAccountHostedArtifactReader;

        await expect(resolveCandidatePluginCollectionMigrationArtifactAccountHostedTarget({
            accountLifetime,
            isCurrent: () => true,
            facts: targetFacts,
            reader,
        })).resolves.toEqual({ kind: 'unavailable' });
    });

    it('loads the signed migration export from exact target bytes without activating the plugin', async () => {
        const cache = createPluginReactNativeBundleCache();
        const activate = vi.fn();
        const migration = (row: Readonly<Record<string, unknown>>, context: Readonly<{ currentRevision: number }>) => ({ ...row, migrated: context.currentRevision === 14 });
        const loadInstalledBundle = vi.fn(async () => (() => ({
            manifest,
            collectionMigrations: {
                tasks: [{
                    id: 'upgrade-v1-to-v2',
                    fromSchemaVersion: 1,
                    toSchemaVersion: 2,
                    migrate: migration,
                }],
            },
            activate,
        })));
        const loader = createCandidatePluginCollectionMigrationArtifactLoader({
            getCache: () => cache,
            createCacheSink: (lifetime) => createPluginReactNativeArtifactLeaseCacheSink({ cache, lifetime }),
            loaderBackend: {
                backendId: 'commonJs',
                available: true,
                loadInstalledBundle,
            },
            hostPlatform: 'ios',
        });

        const result = await loader.load({
            accountLifetime,
            isCurrent: () => true,
            target: {
                release: { pluginId, version: releaseVersion },
                artifact: {
                    contributionId: 'tasks',
                    artifactId: graph.artifactId,
                    platform: 'ios',
                    digest: graph.digest,
                    hostUiApiRange: graph.hostUiApiRange,
                },
            },
            artifactGraph: graph,
            cacheIdentity,
            appExact: createAppExact(),
        });

        expect(result).toMatchObject({
            kind: 'available',
            candidate: {
                release: { ref: { pluginId, version: releaseVersion } },
                collectionContracts: [expect.objectContaining({ collectionId: 'tasks', schemaVersion: 2 })],
            },
        });
        expect(loadInstalledBundle).toHaveBeenCalledWith(expect.objectContaining({
            moduleReference: { exportName: 'collectionMigrations' },
        }));
        expect(activate).not.toHaveBeenCalled();
        if (result.kind !== 'available') throw new Error('Expected the target candidate Artifact to load.');
        expect(result.candidate.collectionMigrations.tasks?.[0]?.migrate({ id: 'task-1' }, { currentRevision: 14 })).toEqual({
            id: 'task-1',
            migrated: true,
        });
        result.candidate.dispose();
    });

    it('prepares an external target through its exact Account release slot without borrowing an incumbent Artifact id', async () => {
        const cache = createPluginReactNativeBundleCache();
        const targetCacheIdentity = cacheIdentity;
        const targetReadFile = vi.fn(async (_request: Readonly<{ artifact: unknown; accountHostedArtifactId?: string }>) => (
            new Map([[entryPath, new Uint8Array(entryBytes)]])
        ));
        const createAccountHostedTargetSource = vi.fn(() => Object.freeze({
            kind: 'accountHosted' as const,
            fetch: targetReadFile,
        }));
        const loader = createCandidatePluginCollectionMigrationArtifactLoader({
            getCache: () => cache,
            createCacheSink: (lifetime) => createPluginReactNativeArtifactLeaseCacheSink({ cache, lifetime }),
            createAccountHostedTargetSource,
            loaderBackend: {
                backendId: 'commonJs',
                available: true,
                loadInstalledBundle: async () => (() => ({
                    manifest,
                    collectionMigrations: {
                        tasks: [{
                            id: 'upgrade-v1-to-v2',
                            fromSchemaVersion: 1,
                            toSchemaVersion: 2,
                            migrate: (row: Readonly<Record<string, unknown>>) => ({ ...row, migrated: true }),
                        }],
                    },
                })),
            },
            hostPlatform: 'ios',
        });

        await expect(loader.load({
            accountLifetime,
            isCurrent: () => true,
            target: {
                release: { pluginId, version: releaseVersion },
                artifact: {
                    contributionId: 'tasks',
                    artifactId: graph.artifactId,
                    platform: 'ios',
                    digest: graph.digest,
                    hostUiApiRange: graph.hostUiApiRange,
                },
            },
            artifactGraph: graph,
            cacheIdentity: targetCacheIdentity,
            accountHosted: {},
        })).resolves.toMatchObject({ kind: 'available' });

        expect(createAccountHostedTargetSource).toHaveBeenCalledWith({ accountLifetime });
        const [targetReadInput] = targetReadFile.mock.calls[0]!;
        expect(targetReadInput).not.toHaveProperty('accountHostedArtifactId');
        expect(targetReadInput).toMatchObject({
            artifact: expect.objectContaining({
                pluginId,
                releaseVersion,
                contributionId: 'tasks',
                digest: graph.digest,
            }),
        });
    });

    it('does not load candidate code after exact target bytes return for a stale selection', async () => {
        const cache = createPluginReactNativeBundleCache();
        let current = true;
        let resolveRead!: (value: ReadonlyMap<string, Uint8Array> | null) => void;
        const delayedRead = new Promise<ReadonlyMap<string, Uint8Array> | null>((resolve) => { resolveRead = resolve; });
        const readFile = vi.fn(async () => await delayedRead);
        const loadInstalledBundle = vi.fn(async () => (() => ({ manifest, collectionMigrations: {} })));
        const loader = createCandidatePluginCollectionMigrationArtifactLoader({
            getCache: () => cache,
            createCacheSink: (lifetime) => createPluginReactNativeArtifactLeaseCacheSink({ cache, lifetime }),
            loaderBackend: {
                backendId: 'commonJs',
                available: true,
                loadInstalledBundle,
            },
            hostPlatform: 'ios',
        });

        const pending = loader.load({
            accountLifetime,
            isCurrent: () => current,
            target: {
                release: { pluginId, version: releaseVersion },
                artifact: {
                    contributionId: 'tasks',
                    artifactId: graph.artifactId,
                    platform: 'ios',
                    digest: graph.digest,
                    hostUiApiRange: graph.hostUiApiRange,
                },
            },
            artifactGraph: graph,
            cacheIdentity,
            appExact: Object.freeze({ kind: 'appExact' as const, fetch: readFile }),
        });
        await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(1));
        current = false;
        resolveRead(new Map([[entryPath, new Uint8Array(entryBytes)]]));

        await expect(pending).resolves.toEqual({
            kind: 'unavailable',
            code: 'candidate_currentness_changed',
        });
        expect(loadInstalledBundle).not.toHaveBeenCalled();
    });
});
