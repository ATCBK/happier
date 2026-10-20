import { describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

installHomeGovernanceBoundaries(createHomeGovernanceHarness());
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

const probe = vi.hoisted(() => ({
    calls: [] as Array<{ fn: string; bytes: number; ms: number }>,
    reset() { probe.calls.length = 0; },
    report(label: string) {
        const byFn = new Map<string, { n: number; bytes: number; ms: number }>();
        for (const c of probe.calls) {
            const e = byFn.get(c.fn) ?? { n: 0, bytes: 0, ms: 0 };
            e.n += 1; e.bytes += c.bytes; e.ms += c.ms;
            byFn.set(c.fn, e);
        }
        const total = probe.calls.reduce((a, c) => ({ n: a.n + 1, bytes: a.bytes + c.bytes, ms: a.ms + c.ms }), { n: 0, bytes: 0, ms: 0 });
        // eslint-disable-next-line no-console
        console.log(`\n### ${label}`);
        for (const [fn, e] of byFn) {
            // eslint-disable-next-line no-console
            console.log(`  ${fn}: passes=${e.n} bytesHashed=${(e.bytes / 1048576).toFixed(2)}MiB ms=${e.ms.toFixed(1)}`);
        }
        // eslint-disable-next-line no-console
        console.log(`  TOTAL: passes=${total.n} bytesHashed=${(total.bytes / 1048576).toFixed(2)}MiB ms=${total.ms.toFixed(1)}`);
        return total;
    },
}));

vi.mock('@happier-dev/protocol/plugins/ui', async (importOriginal) => {
    const original = await importOriginal<typeof import('@happier-dev/protocol/plugins/ui')>();
    const wrap = <A extends unknown[], R>(name: string, fn: (...a: A) => R, size: (...a: A) => number) => (...a: A): R => {
        const t = performance.now();
        const r = fn(...a);
        probe.calls.push({ fn: name, bytes: size(...a), ms: performance.now() - t });
        return r;
    };
    return {
        ...original,
        computePluginUiArtifactSha256DigestV1: wrap(
            'computeBytesDigest',
            original.computePluginUiArtifactSha256DigestV1,
            (bytes: Uint8Array) => bytes.byteLength,
        ),
        verifyPluginUiArtifactBytesIntegrityV1: wrap(
            'verifyBytes',
            original.verifyPluginUiArtifactBytesIntegrityV1,
            (input: { bytes: Uint8Array }) => input.bytes.byteLength,
        ),
        verifyPluginUiArtifactFileSetIntegrityV1: wrap(
            'verifyFileSet',
            original.verifyPluginUiArtifactFileSetIntegrityV1,
            (input: { files: readonly { bytes: Uint8Array }[] }) => input.files.reduce((a, f) => a + f.bytes.byteLength, 0),
        ),
        computePluginUiArtifactFileSetSha256DigestV1: wrap(
            'computeFileSetDigest',
            original.computePluginUiArtifactFileSetSha256DigestV1,
            (files: readonly { bytes: Uint8Array }[]) => files.reduce((a, f) => a + f.bytes.byteLength, 0),
        ),
    };
});

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
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
    derivePluginUiPersistentArtifactKey,
    type PluginUiPersistentArtifactRecord,
    type PluginUiPersistentArtifactStore,
} from '@/sync/domains/plugins/ui/artifactByteCache';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';

import { createPluginAccountAvailabilityReader, type PluginAccountAvailabilitySnapshot } from './reader';
const { createPluginReactNativeArtifactAvailabilityProducer } = await import('./reactNativeArtifactAvailability');

const scope = { serverId: 'server-a', accountId: 'account-a' } as const;
const permanentlyCurrentLifetime: ActiveServerAccountScopeLifetime = Object.freeze({
    scope,
    isCurrent: () => true,
    onRetire: () => Object.freeze({ dispose: () => {} }),
});

const inactiveAppExactSource = Object.freeze({ kind: 'appExact' as const, fetch: async () => null });

// Realistic single-file CommonJS RN plugin bundle (the canonical executable grammar is one file).
const ENTRY_BYTES_SIZE = 3 * 1024 * 1024;

function pseudoJsBytes(size: number, seed: number): Uint8Array {
    const out = new Uint8Array(size);
    let x = seed >>> 0;
    for (let i = 0; i < size; i += 1) {
        x = (x * 1664525 + 1013904223) >>> 0;
        out[i] = 32 + (x % 94);
    }
    return out;
}

function createPersistentStore() {
    const records = new Map<string, PluginUiPersistentArtifactRecord>();
    const keyFor = derivePluginUiPersistentArtifactKey;
    const store: PluginUiPersistentArtifactStore = {
        read: async (identity) => records.get(keyFor(identity)) ?? null,
        write: async (record) => {
            records.set(keyFor(record.persistentIdentity), record);
            return 'persisted';
        },
        remove: async (identity) => { records.delete(keyFor(identity)); },
        removeAccount: async () => undefined,
    };
    return { records, store };
}

function fixture() {
    const artifactContributionId = 'native-preview';
    const artifactId = 'native-preview-artifact';
    const entryPath = `react-native/${artifactId}/entry.cjs.bundle`;
    const entryBytes = pseudoJsBytes(ENTRY_BYTES_SIZE, 1);
    const files = [
        { relativePath: entryPath, digest: computePluginUiArtifactSha256DigestV1(entryBytes), byteSize: entryBytes.byteLength },
    ] as const;
    const artifactDigest = computePluginUiArtifactFileSetSha256DigestV1([
        { relativePath: entryPath, bytes: entryBytes },
    ]);
    const archiveDigestSha256 = PluginUiArtifactDigestV1Schema.parse(`sha256:${'a'.repeat(64)}`);
    const release = PluginReleaseFactsV1Schema.parse({
        ref: { pluginId: 'com.acme.preview', version: '1.2.3' },
        archiveDigestSha256,
        normalizedManifest: {
            schemaVersion: 2, id: 'com.acme.preview', version: '1.2.3', displayName: 'Acme preview',
            engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: {},
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
        serverIdentityId: 'srv_account_one', machineId: 'machine-a', materializationId: 'install-epoch-a',
        pluginId: 'com.acme.preview', version: '1.2.3', sourceClass: 'versionedArchive', portableRelease: true,
        archiveDigestSha256,
        uiArtifacts: [{
            contributionId: artifactContributionId,
            artifactId,
            tier: 'reactNative',
            platform: 'ios',
            artifactDigest,
            hostUiApiRange: '^1.0.0',
        }],
        enabled: true, trustState: 'trusted', observedAt: 1,
    };
    const snapshot = {
        availabilityCursor: 7,
        intentReads: [{
            pluginId: materialization.pluginId,
            response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
                availabilityCursor: 7,
                packageAssets: [],
                hostingCapability: { enabled: false },
                intent: {
                    pluginId: materialization.pluginId, desiredVersion: materialization.version, enabled: true,
                    offlineUiHosting: 'disabled', writableCollections: [], revision: 'intent-1',
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
    const graph = {
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
        materializationRef: { machineId: materialization.machineId, materializationId: materialization.materializationId, pluginId: materialization.pluginId },
    } as const;
    const entryBase64 = encodeBase64(entryBytes);
    const daemonResponse = {
        ok: true as const, artifactFamily: 'reactNative' as const,
        cacheIdentity: { artifactDigest },
        artifact: {
            artifactKind: 'reactNativeBundle' as const, digest: artifactDigest, format: 'plainJs' as const,
            byteSize: entryBytes.byteLength,
        },
        bytesBase64: entryBase64,
        files: [
            { ...files[0], bytesBase64: entryBase64 },
        ],
    };
    const wireBytes = JSON.stringify(daemonResponse).length;
    return { reader, cacheIdentity, graph, origin, daemonResponse, entryBytes, entryPath, wireBytes, entryBase64 };
}

describe('U6 cold-mount integrity probe', () => {
    it('counts full-bytes hash passes on a cold daemon-sourced mount', async () => {
        const current = fixture();
        // eslint-disable-next-line no-console
        console.log(`\n=== wire payload: ${(current.wireBytes / 1048576).toFixed(2)}MiB for ${(ENTRY_BYTES_SIZE / 1048576).toFixed(2)}MiB of artifact`);
        // eslint-disable-next-line no-console
        console.log(`=== entry base64 appears at top level (${(current.entryBase64.length / 1048576).toFixed(2)}MiB) AND inside files[] (${(current.entryBase64.length / 1048576).toFixed(2)}MiB)`);

        const persistent = createPersistentStore();
        const cache = createPluginReactNativeBundleCache({ persistentStore: undefined });
        const producer = createPluginReactNativeArtifactAvailabilityProducer({
            getCache: () => cache,
            appExact: inactiveAppExactSource,
            fetchDaemonArtifactBytes: async () => current.daemonResponse,
        });
        void persistent;

        probe.reset();
        const t0 = performance.now();
        const acquired = await producer.acquire({
            reader: current.reader, artifactGraph: current.graph, cacheIdentity: current.cacheIdentity,
            accountLifetime: permanentlyCurrentLifetime,
            daemon: { machineId: current.origin.materializationRef.machineId, serverId: scope.serverId },
            isCurrent: () => true,
        });
        const wall = performance.now() - t0;
        expect(acquired).toMatchObject({ kind: 'available' });
        const total = probe.report(`COLD daemon mount (no persistent store) wall=${wall.toFixed(1)}ms`);
        expect(total.n).toBeGreaterThan(0);
    }, 120_000);

    it('counts full-bytes hash passes on a cold daemon-sourced mount WITH persistent custody', async () => {
        const current = fixture();
        const persistent = createPersistentStore();
        const cache = createPluginReactNativeBundleCache({ persistentStore: {
            read: async (identity) => {
                const record = await persistent.store.read(identity);
                return record ? { ...record, persistentIdentity: identity } as never : null;
            },
            write: async (record) => persistent.store.write(record),
            remove: async (identity) => { await persistent.store.remove(identity); },
            removeAccount: async () => undefined,
        } });
        const producer = createPluginReactNativeArtifactAvailabilityProducer({
            getCache: () => cache,
            appExact: inactiveAppExactSource,
            fetchDaemonArtifactBytes: async () => current.daemonResponse,
        });

        probe.reset();
        const t0 = performance.now();
        const acquired = await producer.acquire({
            reader: current.reader, artifactGraph: current.graph, cacheIdentity: current.cacheIdentity,
            accountLifetime: permanentlyCurrentLifetime,
            daemon: { machineId: current.origin.materializationRef.machineId, serverId: scope.serverId },
            isCurrent: () => true,
        });
        const wall = performance.now() - t0;
        expect(acquired).toMatchObject({ kind: 'available' });
        probe.report(`COLD daemon mount + persistent write wall=${wall.toFixed(1)}ms`);

        // Second cold mount on a fresh cache reading the SAME persistent record.
        const cache2 = createPluginReactNativeBundleCache({ persistentStore: {
            read: async (identity) => {
                const record = await persistent.store.read(identity);
                return record ? { ...record, persistentIdentity: identity } as never : null;
            },
            write: async (record) => persistent.store.write(record),
            remove: async (identity) => { await persistent.store.remove(identity); },
            removeAccount: async () => undefined,
        } });
        const producer2 = createPluginReactNativeArtifactAvailabilityProducer({
            getCache: () => cache2,
            appExact: inactiveAppExactSource,
            fetchDaemonArtifactBytes: async () => { throw new Error('daemon must not be contacted'); },
        });
        probe.reset();
        const t1 = performance.now();
        const acquired2 = await producer2.acquire({
            reader: current.reader, artifactGraph: current.graph, cacheIdentity: current.cacheIdentity,
            accountLifetime: permanentlyCurrentLifetime,
            daemon: { machineId: current.origin.materializationRef.machineId, serverId: scope.serverId },
            isCurrent: () => true,
        });
        const wall2 = performance.now() - t1;
        expect(acquired2).toMatchObject({ kind: 'available' });
        probe.report(`COLD mount from PERSISTENT cache wall=${wall2.toFixed(1)}ms`);
    }, 120_000);
});
