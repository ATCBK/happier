import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderWithAppProviders } from '@/dev/testkit/render/renderWithAppProviders';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';

const packaged = vi.hoisted(() => ({
    bytes: new TextEncoder().encode('const React = require("react"); module.exports.renderSurface = () => React.createElement("Text", { testID: "host-bundled-account-page" }, "Account page");'),
    machineRpc: vi.fn(),
}));

// The app-package inventory and native asset IO are the physical bundle boundary.
// Declaration admission, AppShell composition, Artifact verification and evaluation stay real.
vi.mock('./generatedBundledPluginUiArtifacts', async () => {
    const { computePluginUiArtifactFileSetSha256DigestV1, computePluginUiArtifactSha256DigestV1, PluginUiArtifactsManifestEntryV2Schema } = await import('@happier-dev/protocol/plugins/ui');
    const { PluginPortableReleaseManifestV1Schema } = await import('@happier-dev/protocol/plugins/availability');
    const { projectPluginPortableUiDeclarationsV1 } = await import('@happier-dev/protocol/plugins/contributions/ui');
    const manifest = PluginPortableReleaseManifestV1Schema.parse({
        schemaVersion: 2, id: 'happier.fixture', version: '1.0.0', displayName: 'Fixture', runtime: { apiVersion: 1 },
        contributes: { ui: { renderers: [{ id: 'account', kind: 'reactNative', artifact: 'account', requiredHostMethods: [] }],
            views: [{ id: 'account-page', container: 'appPage', target: { kind: 'app' }, renderer: 'account', title: 'Account page' }] } },
    });
    const relativePath = 'react-native/account/entry.cjs.bundle';
    const digest = computePluginUiArtifactFileSetSha256DigestV1([{ relativePath, bytes: packaged.bytes }]);
    const artifactGraph = PluginUiArtifactsManifestEntryV2Schema.parse({ artifactId: 'account', tier: 'reactNative', entry: relativePath, digest,
        files: [{ relativePath, digest: computePluginUiArtifactSha256DigestV1(packaged.bytes), byteSize: packaged.bytes.byteLength }],
        builtWith: { bundler: 'esbuild', version: '0.27.2' }, executable: { exports: ['renderSurface'] }, hostUiApiRange: '^1.0.0' });
    const uiDeclaration = { pluginId: manifest.id, pluginVersion: manifest.version, displayName: 'Fixture', packageName: '@happier-dev/plugins-fixture',
        entriesById: projectPluginPortableUiDeclarationsV1(manifest, [artifactGraph]) };
    return { BUNDLED_PLUGIN_UI_APP_ARTIFACTS: [{ pluginId: manifest.id, releaseVersion: manifest.version,
        artifactId: artifactGraph.artifactId, tier: artifactGraph.tier, digest, artifactGraph, uiDeclaration,
        files: [{ relativePath, asset: 1 }] }], BUNDLED_PLUGIN_BRAND_MARKS: [] };
});
vi.mock('expo-asset', () => ({ Asset: { fromModule: () => ({
    localUri: 'file:///test-app/entry.cjs.bundle', downloadAsync: async () => undefined,
}) } }));
vi.mock('expo-file-system', () => ({ File: class {
    exists = true;
    bytes = async () => packaged.bytes;
} }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(input => {
        packaged.machineRpc(input);
        throw new Error('No daemon is reachable');
    });
});

const account = createProviderSettingsAccountHarness();
const { storage } = await import('@/sync/domains/state/storage');
const { AppShellPluginUiProjectionProvider, useAppShellPluginUiProjection } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const { PluginSurfacePlacementHost } = await import('@/components/plugins/surfaces/PluginSurfaceHost');
const { replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } = await import('./projection');
const { BUNDLED_PLUGIN_UI_APP_ARTIFACTS } = await import('./generatedBundledPluginUiArtifacts');
const { PluginMachineMaterializationV1Schema } = await import('@happier-dev/protocol/plugins/availability');
const { normalizePluginInstalledUiDeclarations } = await import('@/sync/domains/plugins/ui/projection');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { createInstalledPluginUiReactNativeRuntimeProjectionSource } = await import('@/components/plugins/reactNative/projectionInvalidation');
const enabledPluginFeatures = createRootLayoutFeaturesResponse({ features: { plugins: {
    enabled: true, ui: { enabled: true, hostedWeb: { enabled: true }, reactNativeBundles: { enabled: true } },
} } });

afterEach(async () => {
    clearPluginAccountAvailabilityProjection();
    await account.reset();
    storage.setState(storage.getInitialState(), true);
    vi.restoreAllMocks();
});

it('admits a direct RN surface from its target Home while the active Account Home disables Plugin UI', async () => {
    await account.restore({ machines: [], features: createRootLayoutFeaturesResponse({ features: { plugins: {
        enabled: false, ui: { enabled: false, reactNativeBundles: { enabled: false }, hostedWeb: { enabled: false } },
    } } }), serverIdentityId: 'srv_bundled_account_page' });
    const targetServerId = await account.addHome({ name: 'Target Home', serverUrl: 'https://bundle-target-home.test',
        serverIdentityId: 'srv_bundle_target', accountId: 'target-account', active: false, features: enabledPluginFeatures });
    const scope = storage.getState().profileScope!;
    replacePluginAccountAvailabilityProjection({ scope, snapshot: {
        availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [],
    } });
    const projection = normalizePluginInstalledUiDeclarations(BUNDLED_PLUGIN_UI_APP_ARTIFACTS[0]!.uiDeclaration!.entriesById);
    const placement = projection.surfacePlacementsById['surfacePlacement:happier.fixture:account-page']!;
    const lifetime = captureActiveServerAccountScopeLifetime()!;
    // Model the direct projection producer through its real cache-custody seam;
    // no AppShell Account union or internal feature decision is substituted.
    const source = createInstalledPluginUiReactNativeRuntimeProjectionSource();
    source.update({ projection, accountLifetime: lifetime, isCurrent: lifetime.isCurrent });
    packaged.machineRpc.mockClear();
    const screen = await renderWithAppProviders(<PluginSurfacePlacementHost placement={placement}
        pluginUiProjection={projection} machineId={null} serverId={targetServerId} platform="web"
        projectionInteractionEnabled />);
    try {
        await flushHookEffects();
        expect(screen.tree.root.findAllByProps({ reasonCode: 'feature_gate_disabled' })).toHaveLength(0);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.root.findAllByProps({ testID: 'host-bundled-account-page' }), JSON.stringify(screen.tree.toJSON())).toHaveLength(1);
        });
        expect(storage.getState().profileScope).toEqual(scope);
        expect(packaged.machineRpc).not.toHaveBeenCalled();
        await act(async () => { await account.publishFeatures(targetServerId, createRootLayoutFeaturesResponse({ features: { plugins: {
            enabled: false, ui: { enabled: true, reactNativeBundles: { enabled: true }, hostedWeb: { enabled: true } },
        } } })); });
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.root.findAllByProps({ testID: 'host-bundled-account-page' })).toHaveLength(0);
        });
    } finally { await screen.unmount(); source.dispose(); }
});

it('renders a cold bundled Account page through AppShell and the real Artifact loader with no daemon calls', async () => {
    await account.restore({ machines: [], features: enabledPluginFeatures, serverIdentityId: 'srv_bundled_account_page' });
    packaged.machineRpc.mockClear();
    const scope = storage.getState().profileScope!;
    replacePluginAccountAvailabilityProjection({ scope, snapshot: {
        availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [],
    } });
    function Page() {
        const shell = useAppShellPluginUiProjection();
        const placement = shell.pluginUiProjection?.surfacePlacementsById['surfacePlacement:happier.fixture:account-page'];
        return placement ? <PluginSurfacePlacementHost placement={placement} pluginUiProjection={shell.pluginUiProjection}
            machineId={null} serverId={null} platform="web" projectionInteractionEnabled={shell.interactionEnabled} /> : null;
    }
    const screen = await renderWithAppProviders(<AppShellPluginUiProjectionProvider><Page /></AppShellPluginUiProjectionProvider>);
    try {
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.root.findAllByProps({ testID: 'host-bundled-account-page' }), JSON.stringify(screen.tree.toJSON())).toHaveLength(1);
        });
        expect(packaged.machineRpc).not.toHaveBeenCalled();
        await act(async () => {
            await account.publishMachines(account.serverId, [createMachineFixture({ id: 'machine-asleep', active: false, activeAt: 0 })]);
            const declared = BUNDLED_PLUGIN_UI_APP_ARTIFACTS[0]!.uiDeclaration!.entriesById;
            const materialization = PluginMachineMaterializationV1Schema.parse({
                pluginId: 'happier.fixture', version: '1.0.0', machineId: 'machine-asleep', serverIdentityId: 'srv_bundled_account_page',
                materializationId: 'bundled-install', sourceClass: 'bundledFirstParty', portableRelease: false,
                enabled: true, trustState: 'trusted', observedAt: 1, uiArtifacts: [], declaredUiEntries: declared,
            });
            replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 2, intentReads: [],
                materializations: [materialization], snapshots: [{ serverIdentityId: materialization.serverIdentityId,
                    machineId: materialization.machineId, materializations: [materialization] }] } });
        });
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.root.findAllByProps({ testID: 'host-bundled-account-page' })).toHaveLength(1);
        });
        expect(packaged.machineRpc).not.toHaveBeenCalled();
        await act(async () => {
            await account.publishFeatures(account.serverId, createRootLayoutFeaturesResponse({ features: { plugins: {
                enabled: false,
                ui: { enabled: true, reactNativeBundles: { enabled: true }, hostedWeb: { enabled: true } },
            } } }));
        });
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.root.findAllByProps({ testID: 'host-bundled-account-page' })).toHaveLength(0);
        });
        await act(async () => { await account.publishFeatures(account.serverId, enabledPluginFeatures); });
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.root.findAllByProps({ testID: 'host-bundled-account-page' })).toHaveLength(1);
        });
        await act(async () => {
            replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 2,
                materializations: [], snapshots: [], intentReads: [{ pluginId: 'happier.fixture', response: {
                    availabilityCursor: 2, hostingCapability: { enabled: false }, release: null, packageAssets: [], uiArtifacts: [],
                    intent: { pluginId: 'happier.fixture', enabled: false, desiredVersion: null, revision: 'disabled',
                        offlineUiHosting: 'disabled', writableCollections: [] },
                } }] } });
        });
        expect(screen.tree.root.findAllByProps({ testID: 'host-bundled-account-page' })).toHaveLength(0);
        expect(packaged.machineRpc).not.toHaveBeenCalled();
    } finally { await screen.unmount(); }
});
