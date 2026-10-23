import { afterEach, expect, it, vi } from 'vitest';
import { PluginContributesV2Schema } from '@happier-dev/protocol';
import type { PluginClientApi } from '@happier-dev/plugin-sdk';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY } from '@/sync/domains/plugins/ui/projectionUnion';
import { createPluginAccountAvailabilityReaderStore } from '@/sync/domains/plugins/availability/reader';
import { BUNDLED_PLUGIN_UI_APP_ARTIFACTS } from '@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { reconcileProjectedPluginUiClientExecutables, retainProjectedPluginUiClientExecutables } from './clientExecutableActivation';
import { createPluginUiExecutableModuleHost } from './executableModuleHost';
import { getPluginUiClientExecutableComposition } from './clientExecutableContributions';
import { resolveProjectedPluginUiClientExecutables } from './clientExecutableProjection';
import { createPluginUiCommonJsLoaderBackend } from './commonJsLoaderBackend';
import { encodeBase64 } from '@/encryption/base64';
import { PluginReleaseFactsV1Schema, PluginMachineMaterializationV1Schema } from '@happier-dev/protocol/plugins/availability';
import { DaemonPluginUiArtifactBytesReadRequestSchema, DaemonPluginUiArtifactBytesReadResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

const assetIo = vi.hoisted(() => ({ read: vi.fn<(id: number) => Promise<Uint8Array>>() }));
const rpcIo = vi.hoisted(() => ({ request: vi.fn<(input: Readonly<{
    machineId: string; serverId?: string | null; method: string; payload: unknown;
}>) => Promise<unknown>>(async () => ({ ok: false, code: 'artifact_unavailable', diagnostics: [] })) }));

// Only packaged inventory and asset IO are replaced. Projection, Availability,
// verification, cache materialization and complete-set registration stay real.
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', async () => {
    const { computePluginUiArtifactFileSetSha256DigestV1, computePluginUiArtifactSha256DigestV1,
        PluginUiArtifactsManifestEntryV2Schema } = await import('@happier-dev/protocol/plugins/ui');
    return { BUNDLED_PLUGIN_BRAND_MARKS: [], BUNDLED_PLUGIN_UI_APP_DECLARATIONS: [], BUNDLED_PLUGIN_UI_APP_ARTIFACTS: [1, 2].map(id => {
        const bytes = new TextEncoder().encode(`// target ${id}`);
        const entry = 'react-native/action/entry.cjs.bundle';
        const digest = computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: entry, bytes }]);
        const artifactGraph = PluginUiArtifactsManifestEntryV2Schema.parse({ artifactId: 'action', tier: 'reactNative', entry,
            files: [{ relativePath: entry, digest: computePluginUiArtifactSha256DigestV1(bytes), byteSize: bytes.byteLength }],
            digest, builtWith: { bundler: 'esbuild', version: '0.27.2' }, executable: { exports: ['activate'] }, hostUiApiRange: '^1.0.0' });
        return { pluginId: `acme.concurrent-${id}`, artifactId: 'action', tier: 'reactNative', digest, releaseVersion: '1.0.0',
            artifactGraph, files: [{ relativePath: entry, asset: id }] };
    }) };
});
vi.mock('expo-asset', () => ({ Asset: { fromModule: (id: number) => ({
    localUri: `file:///fixture/${id}`, downloadAsync: async () => undefined,
}) } }));
vi.mock('expo-file-system', () => ({ File: class {
    exists = true;
    constructor(private uri: string) {}
    bytes = () => assetIo.read(Number(this.uri.split('/').at(-1)));
} }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(rpcIo.request);
});

// Compile the maintained external author fixture once during collection. Its
// bytes are not part of the packaged app inventory or any preseeded cache.
const authoredAccountArtifact = await (async () => {
    const { resolve, join } = await import('node:path');
    const { readFile } = await import('node:fs/promises');
    const { compileUniversalPluginUiCommonJs } = await import('../../../../../../packages/plugin-sdk/src/ui/build/universalCommonJsCompiler');
    const { readWorkspacePackages, packageNameOfSpecifier, resolveWorkspaceSource } = await import('../../../../../../packages/cli-common/sourceRuntimeEntries.mjs');
    const { manifest } = await import('../../../../../../packages/plugin-sdk/fixtures/account-actions/src/index');
    const { computePluginUiArtifactFileSetSha256DigestV1, computePluginUiArtifactSha256DigestV1,
        PluginUiArtifactsManifestEntryV2Schema } = await import('@happier-dev/protocol/plugins/ui');
    const root = resolve(process.cwd(), '../..');
    const projectRoot = join(root, 'packages/plugin-sdk/fixtures/account-actions');
    const packageJson: { exports: Record<string, string> } = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
    const packages = await readWorkspacePackages(root);
    const compiled = await compileUniversalPluginUiCommonJs({ projectRoot,
        entryPath: resolve(projectRoot, packageJson.exports['./happier-plugin-ui/account-runtime']!),
        artifactId: 'account-runtime', requestedExports: ['activate'], exportConditions: ['happier-source'],
        resolveSourceImport: specifier => packages.has(packageNameOfSpecifier(specifier))
            ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native', 'browser'] }) : undefined,
    });
    const graph = PluginUiArtifactsManifestEntryV2Schema.parse({ artifactId: compiled.artifactId, tier: 'reactNative',
        entry: compiled.relativePath, digest: computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: compiled.relativePath, bytes: compiled.bytes }]),
        files: [{ relativePath: compiled.relativePath, digest: computePluginUiArtifactSha256DigestV1(compiled.bytes), byteSize: compiled.bytes.length }],
        builtWith: { bundler: 'esbuild', version: compiled.esbuildVersion }, executable: { exports: compiled.exports }, hostUiApiRange: '^1.0.0' });
    return { manifest, graph, bytes: compiled.bytes };
})();

function fixture() {
    let current = true;
    const listeners = new Set<() => void>();
    const lifetime: ActiveServerAccountScopeLifetime = {
        scope: { serverId: 'concurrent-home', accountId: 'concurrent-account' },
        isCurrent: () => current,
        onRetire: listener => { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
    };
    const store = createPluginAccountAvailabilityReaderStore();
    store.replace({ scope: lifetime.scope, snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
    let installedPackagesById: PluginUiProjectionModel['installedPackagesById'] = {};
    let actionsById: PluginUiProjectionModel['actionsById'] = {};
    let reactNativeBundlesById: PluginUiProjectionModel['reactNativeBundlesById'] = {};
    for (const artifact of BUNDLED_PLUGIN_UI_APP_ARTIFACTS) {
        const origin = { machineId: 'byte-supplier', serverId: lifetime.scope.serverId,
            interactionEnabled: true, phase: 'current' as const, executionOrigin: null };
        const action = PluginContributesV2Schema.parse({ actions: [{ id: 'run', title: 'Run', scopes: ['session'],
            surfaces: ['ui'], placementBindings: ['detailsPanel'], dangerLevel: 'safe',
            execution: { target: 'client', client: { artifactId: artifact.artifactId, exportName: 'activate' }, platforms: ['web'] },
        }] }).actions[0]!;
        installedPackagesById = { ...installedPackagesById, [artifact.pluginId]: {
            id: artifact.pluginId, displayName: artifact.pluginId, version: '1.0.0', enabled: true,
            source: { kind: 'bundled', locator: artifact.pluginId },
        } };
        actionsById = { ...actionsById, [`${artifact.pluginId}/run`]: {
            ...action, pluginId: artifact.pluginId, occurrenceId: `${artifact.pluginId}:current`, available: true,
            [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: origin,
        } };
        reactNativeBundlesById = { ...reactNativeBundlesById, [`reactNativeBundle:${artifact.pluginId}:run`]: {
            id: `reactNativeBundle:${artifact.pluginId}:run`, pluginId: artifact.pluginId, contributionKind: 'reactNativeBundle',
            contributionId: 'run', generatedOwnerKind: 'clientContribution', artifactGraph: artifact.artifactGraph,
            executionOrigin: null, artifactSelectionOwner: 'daemonProjection',
            runtime: { decision: { state: 'load' }, loadPolicy: { source: 'installedArtifact' }, cacheIdentity: { artifactDigest: artifact.digest } },
            [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: origin,
        } };
    }
    const model: PluginUiProjectionModel = { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 1,
        installedPackagesById, actionsById, reactNativeBundlesById };
    const host = createPluginUiExecutableModuleHost();
    const loaded: string[] = [];
    const input = { actionProjection: { projection: model }, platform: 'web' as const, executableHost: host,
        reader: store.bind(lifetime.scope), accountLifetime: lifetime, loaderBackend: {
            backendId: 'commonJs' as const, available: true,
            loadInstalledBundle: async ({ identity }: { identity: { pluginId: string } }) => (api: PluginClientApi) => {
                loaded.push(identity.pluginId);
                api.actions.register('run', async () => identity.pluginId);
            },
        } };
    return { input, loaded, composition: getPluginUiClientExecutableComposition(host), listeners,
        retire: () => { current = false; for (const listener of [...listeners]) listener(); } };
}

afterEach(() => {
    assetIo.read.mockReset();
    rpcIo.request.mockReset().mockImplementation(async () => ({ ok: false, code: 'artifact_unavailable', diagnostics: [] }));
});

it('registers a selected external Account release from its advertised byte supplier without a Machine execution target', async () => {
    const { manifest, graph, bytes } = authoredAccountArtifact;
    const scope = { serverId: 'account-byte-home', accountId: 'account-byte-owner' };
    let current = true;
    const cancellations = new Set<() => void>();
    const lifetime: ActiveServerAccountScopeLifetime = { scope, isCurrent: () => current,
        onRetire: cancel => { cancellations.add(cancel); return { dispose: () => { cancellations.delete(cancel); } }; } };
    const slots = manifest.contributes.actions.flatMap(action => (['web', 'ios', 'android'] as const).map(platform => ({
        contributionId: action.id, artifactId: graph.artifactId, tier: 'reactNative' as const, platform,
        artifactDigest: graph.digest, hostUiApiRange: graph.hostUiApiRange, artifactGraph: graph,
    })));
    const release = PluginReleaseFactsV1Schema.parse({ ref: { pluginId: manifest.id, version: manifest.version },
        archiveDigestSha256: `sha256:${'f'.repeat(64)}`, normalizedManifest: manifest,
        collectionContracts: [], uiSlots: slots, packageAssetArchive: { archiveDigestSha256: `sha256:${'e'.repeat(64)}`, resources: [] } });
    const materialization = PluginMachineMaterializationV1Schema.parse({ serverIdentityId: 'srv_account_byte_supplier',
        machineId: 'installed-byte-supplier', materializationId: 'external-installation', pluginId: manifest.id,
        version: manifest.version, sourceClass: 'versionedArchive', portableRelease: true,
        archiveDigestSha256: release.archiveDigestSha256, uiArtifacts: slots.map(({ artifactGraph: _graph, ...slot }) => slot),
        enabled: true, trustState: 'trusted', observedAt: 1 });
    const store = createPluginAccountAvailabilityReaderStore();
    store.replace({ scope, snapshot: { availabilityCursor: 1,
        materializations: [materialization], snapshots: [{ serverIdentityId: materialization.serverIdentityId,
            machineId: materialization.machineId, materializations: [materialization] }],
        intentReads: [{ pluginId: manifest.id, response: { availabilityCursor: 1, hostingCapability: { enabled: false },
            intent: { pluginId: manifest.id, desiredVersion: manifest.version, enabled: true, offlineUiHosting: 'disabled',
                writableCollections: [], revision: 'selected-1' }, release, uiArtifacts: [], packageAssets: [] } }],
    } });
    const reader = store.bind(scope);
    const projection = reader.readAccountUiProjection();
    if (!projection) throw new Error('Expected selected Account declarations');
    const targets = resolveProjectedPluginUiClientExecutables({ actionProjection: { projection }, platform: 'web' });
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ authority: { kind: 'account' }, executionOrigin: null });
    const byteResponse = DaemonPluginUiArtifactBytesReadResponseSchema.parse({ ok: true, artifactFamily: 'reactNative',
        cacheIdentity: { artifactDigest: graph.digest }, artifact: { artifactKind: 'reactNativeBundle',
            digest: graph.digest, format: 'plainJs', byteSize: bytes.length },
        files: graph.files.map(file => ({ ...file, bytesBase64: encodeBase64(bytes) })) });
    rpcIo.request.mockImplementation(async input => {
        expect(input.machineId).toBe(materialization.machineId);
        const request = DaemonPluginUiArtifactBytesReadRequestSchema.parse(input.payload);
        expect(request.cacheIdentity.artifactDigest).toBe(graph.digest);
        return byteResponse;
    });
    const host = createPluginUiExecutableModuleHost();
    const composition = getPluginUiClientExecutableComposition(host);
    try {
        const attempts = await reconcileProjectedPluginUiClientExecutables({ actionProjection: { projection }, platform: 'web',
            accountLifetime: lifetime, reader, executableHost: host, loaderBackend: createPluginUiCommonJsLoaderBackend() });
        expect(rpcIo.request).toHaveBeenCalled();
        expect(attempts).toMatchObject([{ result: { ok: true } }]);
        for (const action of manifest.contributes.actions) {
            expect(composition.read({ family: 'actions', pluginId: manifest.id, localId: action.id,
                occurrenceId: targets[0]!.occurrenceId, executionOrigin: null, target: targets[0]!.target }))
                .toMatchObject({ authority: { kind: 'account' } });
        }
        expect(rpcIo.request).toHaveBeenCalled();
    } finally {
        current = false;
        for (const cancel of [...cancellations]) cancel();
        await composition.unload();
        expect(cancellations.size).toBe(0);
    }
});

it('starts both cold preparations before either completes and commits in target order', async () => {
    const state = fixture();
    const releases = new Map<number, () => void>();
    assetIo.read.mockImplementation(async id => {
        await new Promise<void>(resolve => { releases.set(id, resolve); });
        return new TextEncoder().encode(`// target ${id}`);
    });
    const pending = reconcileProjectedPluginUiClientExecutables(state.input);
    try {
        await vi.waitFor(() => expect([...releases.keys()]).toEqual([1, 2]));
        releases.get(2)!();
        expect(state.loaded).toEqual([]);
        releases.get(1)!();
        expect(await pending).toMatchObject([{ result: { ok: true } }, { result: { ok: true } }]);
        expect(state.loaded).toEqual(['acme.concurrent-1', 'acme.concurrent-2']);
    } finally {
        state.retire();
        for (const release of releases.values()) release();
        await pending;
        await state.composition.unload();
        expect(state.listeners.size).toBe(0);
    }
});

it.each(['superseded', 'account-retired'] as const)('releases all cold preparations when %s', async retirement => {
    const state = fixture();
    const releases = new Map<number, () => void>();
    let current = true;
    assetIo.read.mockImplementation(async id => {
        await new Promise<void>(resolve => { releases.set(id, resolve); });
        return new TextEncoder().encode(`// target ${id}`);
    });
    const pending = reconcileProjectedPluginUiClientExecutables({ ...state.input, isCurrent: () => current });
    try {
        await vi.waitFor(() => expect(releases.size).toBe(2));
        releases.get(1)!();
        await vi.waitFor(() => expect(state.listeners.size).toBeGreaterThan(1));
        if (retirement === 'superseded') current = false;
        else state.retire();
        releases.get(2)!();
        expect(await pending).toEqual([]);
        expect(state.loaded).toEqual([]);
    } finally {
        state.retire();
        for (const release of releases.values()) release();
        await pending;
        await state.composition.unload();
        expect(state.listeners.size).toBe(0);
    }
});

it('commits a successful target when the other target has corrupt bytes and no daemon fallback', async () => {
    const state = fixture();
    assetIo.read.mockImplementation(async id => new TextEncoder().encode(id === 2 ? 'corrupt' : `// target ${id}`));
    try {
        expect(await reconcileProjectedPluginUiClientExecutables(state.input)).toMatchObject([{ result: { ok: true } }]);
        expect(state.loaded).toEqual(['acme.concurrent-1']);
    } finally {
        state.retire();
        await state.composition.unload();
        expect(state.listeners.size).toBe(0);
    }
});

it('keeps retained predecessor registrations when a successor is superseded', async () => {
    const state = fixture();
    assetIo.read.mockImplementation(async id => new TextEncoder().encode(`// target ${id}`));
    await reconcileProjectedPluginUiClientExecutables({ ...state.input, retainCommittedActivation: true });
    await retainProjectedPluginUiClientExecutables(state.input);
    let current = true;
    const pending = reconcileProjectedPluginUiClientExecutables({ ...state.input, retainCommittedActivation: true, isCurrent: () => current });
    current = false;
    expect(await pending).toEqual([]);
    expect(state.loaded).toEqual(['acme.concurrent-1', 'acme.concurrent-2']);
    for (const artifact of BUNDLED_PLUGIN_UI_APP_ARTIFACTS) {
        expect(state.composition.read({ family: 'actions', pluginId: artifact.pluginId,
            occurrenceId: `${artifact.pluginId}:current`, localId: 'run',
            target: { artifactId: artifact.artifactId, exportName: 'activate', platform: 'web' },
            executionOrigin: null,
        })).not.toBeNull();
    }
    state.retire();
    await state.composition.unload();
    expect(state.listeners.size).toBe(0);
});
