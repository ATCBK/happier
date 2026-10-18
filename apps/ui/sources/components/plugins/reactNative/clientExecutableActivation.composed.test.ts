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

const assetIo = vi.hoisted(() => ({ read: vi.fn<(id: number) => Promise<Uint8Array>>() }));

// Only packaged inventory and asset IO are replaced. Projection, Availability,
// verification, cache materialization and complete-set registration stay real.
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', async () => {
    const { computePluginUiArtifactFileSetSha256DigestV1, computePluginUiArtifactSha256DigestV1,
        PluginUiArtifactsManifestEntryV2Schema } = await import('@happier-dev/protocol/plugins/ui');
    return { BUNDLED_PLUGIN_BRAND_MARKS: [], BUNDLED_PLUGIN_UI_APP_ARTIFACTS: [1, 2].map(id => {
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
    return createServerScopedMachineRpcBoundaryMock(async () => ({
        ok: false, code: 'artifact_unavailable', diagnostics: [],
    }));
});

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
        const origin = { machineId: 'byte-supplier', serverId: lifetime.scope.serverId, generation: 1,
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

afterEach(() => { assetIo.read.mockReset(); });

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
