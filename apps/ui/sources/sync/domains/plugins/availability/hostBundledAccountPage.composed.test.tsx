import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderWithAppProviders } from '@/dev/testkit/render/renderWithAppProviders';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createAccountNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';

const packaged = vi.hoisted(() => ({
    bytes: new TextEncoder().encode(`
const React = require("react");
const { defineUiSurface, usePluginHostApi, useSurfaceContext, TargetedSurface } = require("@happier-dev/plugin-ui");
const { usePluginUiEphemeralSharedScope } = require("@happier-dev/plugin-ui/hostApi");
function AccountPage() {
    const hostApi = usePluginHostApi();
    const context = useSurfaceContext();
    const detail = context.targetedContributions && context.targetedContributions.points
        .flatMap(point => point.protocols).flatMap(protocol => protocol.contributions)
        .flatMap(contribution => contribution.surfaces)[0];
    const [result, setResult] = React.useState(null);
    const scope = usePluginUiEphemeralSharedScope();
    const [sharedValue, setSharedValue] = React.useState(null);
    React.useEffect(() => {
        if (!scope) return;
        const lease = scope.acquire("account-page", () => ({ value: "Account page", dispose() {} }));
        setSharedValue(lease ? lease.value : null);
        return () => lease?.release();
    }, [scope]);
    return React.createElement("Text", { testID: "host-bundled-account-page" },
        React.createElement("Text", { testID: "account-page-invoke", onPress: async () => {
            try { setResult(await hostApi.executeAction("read", {})); }
            catch (error) { setResult({ code: error.code, message: error.message, diagnostics: error.diagnostics }); }
        } }, "Read Account"),
        result ? React.createElement("Text", { testID: "account-page-result" }, JSON.stringify(result)) : null,
        detail ? React.createElement(TargetedSurface, { surface: detail, input: { id: "personal" } }) : null,
        sharedValue
        ? React.createElement("Text", { testID: "host-bundled-shared-scope-ready" }, sharedValue)
        : "Account page");
}
module.exports.renderSurface = defineUiSurface(function() {
    const context = useSurfaceContext();
    return React.createElement(context.mount && context.mount.kind === "embedded" ? AccountDetail : AccountPage);
});
function AccountDetail() {
    const hostApi = usePluginHostApi();
    const [result, setResult] = React.useState(null);
    return React.createElement("Text", { testID: "account-detail" }, "Personal Account detail",
        React.createElement("Text", { testID: "account-detail-invoke", onPress: async () => {
            try { setResult(await hostApi.executeAction("nested", {})); }
            catch (error) { setResult({ code: error.code }); }
        } }, "Read source"),
        React.createElement("Text", { testID: "account-detail-local-machine-invoke", onPress: async () => {
            setResult(await hostApi.executeAction("nested-local", {}));
        } }, "Read local source"),
        React.createElement("Text", { testID: "account-detail-host-invoke", onPress: async () => {
            setResult(await hostApi.executeAction("nested-host", {}));
        } }, "Use host Action"),
        React.createElement("Text", { testID: "account-detail-explicit-invoke", onPress: async () => {
            setResult(await hostApi.executeAction("nested-explicit", {}));
        } }, "Use local Action"),
        React.createElement("Text", { testID: "account-detail-local-invoke", onPress: async () => {
            setResult(await hostApi.executeAction("read", {}));
        } }, "Read Account"),
        result ? React.createElement("Text", { testID: "account-detail-result" }, JSON.stringify(result)) : null);
}
module.exports.activate = function(api) { api.actions.register("read", async (_input, context) => ({
    surface: context.surface, caller: context.caller ? context.caller.kind : null
})); api.actions.register("nested", async (_input, context) => {
    try { return await context.services.actions.execute({ pluginId: "acme.provider-source", localId: "list" }, {}); }
    catch (error) { return { code: error.code }; }
}); api.actions.register("nested-local", async (_input, context) => {
    try { return await context.services.actions.execute("local-machine", {}); }
    catch (error) { return { code: error.code }; }
}); api.actions.register("nested-host", async (_input, context) => {
    try { return await context.services.actions.execute("wait", {}); }
    catch (error) { return { code: error.code }; }
}); api.actions.register("nested-explicit", async (_input, context) => {
    try { return await context.services.actions.execute({ pluginId: "happier.fixture", localId: "wait" }, {}); }
    catch (error) { return { code: error.code }; }
}); };`),
    machineRpc: vi.fn<(request: Readonly<{ method: string; payload: unknown }>) => unknown>(),
}));

// The app-package inventory and native asset IO are the physical bundle boundary.
// Declaration admission, AppShell composition, Artifact verification and evaluation stay real.
vi.mock('./generatedBundledPluginUiArtifacts', async () => {
    const { computePluginUiArtifactFileSetSha256DigestV1, computePluginUiArtifactSha256DigestV1, PluginUiArtifactsManifestEntryV2Schema } = await import('@happier-dev/protocol/plugins/ui');
    const { PluginPortableReleaseManifestV1Schema } = await import('@happier-dev/protocol/plugins/availability');
    const { projectPluginPortableUiDeclarationsV1 } = await import('@happier-dev/protocol/plugins/contributions/ui');
    const { definePlugin } = await import('@happier-dev/plugin-sdk');
    const { defineContributionProtocol } = await import('@happier-dev/plugin-sdk/contributions');
    const { defineProtocolObject, defineProtocolString } = await import('@happier-dev/plugin-sdk/protocol');
    const sourceProtocol = defineContributionProtocol({ id: 'account-source', version: 1, operations: {}, surfaces: {
        detail: { required: true, presentation: 'content', inputSchema: defineProtocolObject({ id: defineProtocolString() }, { policy: 'closed' }) },
    } });
    const authored = definePlugin({ id: 'happier.fixture', version: '1.0.0', displayName: 'Fixture',
        contributionPoints: { sources: sourceProtocol.point() },
        actions: { read: { title: 'Read Account', scopes: ['global'], surfaces: ['ui'], placementBindings: [], dangerLevel: 'safe',
            execution: { target: 'account', account: { artifactId: 'account', exportName: 'activate' } }, run: async () => null },
            nested: { title: 'Read source', scopes: ['global'], surfaces: ['ui'], placementBindings: [], dangerLevel: 'safe',
                execution: { target: 'account', account: { artifactId: 'account', exportName: 'activate' } }, run: async () => null },
            'nested-local': { title: 'Read local source', scopes: ['global'], surfaces: ['ui'], placementBindings: [], dangerLevel: 'safe',
                execution: { target: 'account', account: { artifactId: 'account', exportName: 'activate' } }, run: async () => null },
            'nested-host': { title: 'Use host Action', scopes: ['global'], surfaces: ['ui'], placementBindings: [], dangerLevel: 'safe',
                execution: { target: 'account', account: { artifactId: 'account', exportName: 'activate' } }, run: async () => null },
            'nested-explicit': { title: 'Use local Action', scopes: ['global'], surfaces: ['ui'], placementBindings: [], dangerLevel: 'safe',
                execution: { target: 'account', account: { artifactId: 'account', exportName: 'activate' } }, run: async () => null },
            'local-machine': { title: 'Local Machine source', scopes: ['global'], surfaces: ['plugin'], placementBindings: [], dangerLevel: 'safe',
                execution: { target: 'daemon' }, run: async () => null },
            wait: { title: 'Local wait', scopes: ['global'], surfaces: ['plugin'], placementBindings: [], dangerLevel: 'safe',
                execution: { target: 'daemon' }, run: async () => null } },
        ui: { renderers: [{ id: 'account', kind: 'reactNative', artifact: 'account', requiredHostMethods: ['readStoredImage', 'executeAction'] },
            { id: 'account-detail', kind: 'reactNative', artifact: 'account', requiredHostMethods: ['executeAction'] }],
            views: [{ id: 'account-page', container: 'appPage', target: { kind: 'app' }, renderer: 'account', title: 'Account page' }] },
        contributesTo: { 'happier.fixture': { sources: { personal: sourceProtocol.contribute({
            operations: {},
            surfaces: { detail: { renderer: 'account-detail' } },
        }) } } },
    });
    const manifest = PluginPortableReleaseManifestV1Schema.parse(authored.manifest);
    const relativePath = 'react-native/account/entry.cjs.bundle';
    const digest = computePluginUiArtifactFileSetSha256DigestV1([{ relativePath, bytes: packaged.bytes }]);
    const artifactGraph = PluginUiArtifactsManifestEntryV2Schema.parse({ artifactId: 'account', tier: 'reactNative', entry: relativePath, digest,
        files: [{ relativePath, digest: computePluginUiArtifactSha256DigestV1(packaged.bytes), byteSize: packaged.bytes.byteLength }],
        builtWith: { bundler: 'esbuild', version: '0.27.2' }, executable: { exports: ['activate', 'renderSurface'] }, hostUiApiRange: '^1.0.0' });
    const uiDeclaration = { pluginId: manifest.id, pluginVersion: manifest.version, displayName: 'Fixture', packageName: '@happier-dev/plugins-fixture',
        entriesById: projectPluginPortableUiDeclarationsV1(manifest, [artifactGraph]),
        normalizedManifest: manifest, artifactGraphs: [artifactGraph],
        declaredExecution: { daemonActions: true, contributionPoints: true } };
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
    return createServerScopedMachineRpcBoundaryMock(async input => {
        const result = packaged.machineRpc(input);
        if (result !== undefined) return result;
        throw new Error('No daemon is reachable');
    });
});

const account = createProviderSettingsAccountHarness();
const { storage } = await import('@/sync/domains/state/storage');
const { AppShellPluginUiProjectionProvider, useAppShellPluginUiProjection } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const { PluginSurfaceHost, PluginSurfacePlacementHost } = await import('@/components/plugins/surfaces/PluginSurfaceHost');
const { NavigationTitleChromeProvider } = await import('@/components/ui/layout/navigationTitleChrome');
const { PluginAppPageScreen } = await import('@/components/appShell/plugins/PluginAppPageScreen');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } = await import('./projection');
const { BUNDLED_PLUGIN_UI_APP_ARTIFACTS } = await import('./generatedBundledPluginUiArtifacts');
const { PluginMachineMaterializationV1Schema } = await import('@happier-dev/protocol/plugins/availability');
const { normalizePluginInstalledUiDeclarations } = await import('@/sync/domains/plugins/ui/projection');
const { normalizePluginUiProjection } = await import('@/sync/domains/plugins/ui/projection');
const { mergeInstalledPluginUiProjections, unionPluginUiProjections } = await import('@/sync/domains/plugins/ui/projectionUnion');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { createInstalledPluginUiReactNativeRuntimeProjectionSource } = await import('@/components/plugins/reactNative/projectionInvalidation');
const { readCurrentAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
const { resolvePluginUiClientActionRegistration } = await import('@/components/plugins/reactNative/clientExecutableContributions');
const { resolvePluginUiClientExecutablePlatform } = await import('@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness');
const enabledPluginFeatures = createRootLayoutFeaturesResponse({ features: { plugins: {
    enabled: true, ui: { enabled: true, hostedWeb: { enabled: true }, reactNativeBundles: { enabled: true } },
} } });

afterEach(async () => {
    packaged.machineRpc.mockReset();
    clearPluginAccountAvailabilityProjection();
    await account.reset();
    storage.setState(storage.getInitialState(), true);
    vi.restoreAllMocks();
});

it.each([
    ['qualified with Machine', true, 'qualified'], ['qualified no Machine', false, 'qualified'], ['bare local no Machine', false, 'bare'],
    ['bare host Action precedence', false, 'host'], ['explicit local host-name no Machine', false, 'explicit'],
] as const)('keeps Account child authority while routing its nested source: %s', async (_label, withMachine, reference) => {
    const nestedAction = reference === 'bare' ? 'nested-local' : reference === 'host' ? 'nested-host'
        : reference === 'explicit' ? 'nested-explicit' : 'nested';
    const invokeTestId = reference === 'bare' ? 'account-detail-local-machine-invoke' : reference === 'host'
        ? 'account-detail-host-invoke' : reference === 'explicit' ? 'account-detail-explicit-invoke' : 'account-detail-invoke';
    const machineId = 'provider-machine';
    await account.restore({ machines: withMachine ? [createMachineFixture({ id: machineId, active: true, activeAt: Date.now() })] : [],
        features: enabledPluginFeatures, serverIdentityId: 'srv_account_child' });
    const lifetime = captureActiveServerAccountScopeLifetime()!;
    replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot: {
        availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [],
    } });
    const { readPluginAccountAvailability } = await import('./projection');
    const { readMountedAccountTargetedContributions } = await import('@/components/plugins/surfaces/mountedAccountTargetedContributions');
    const { prepareTargetedSurfaceMounts } = await import('@/components/plugins/surfaces/mountedTargetedContributions');
    const { readTargetedPluginSurfaceReactMountRequest } = await import('@/components/plugins/surfaces/TargetedPluginSurfaceHost');
    const { PluginProjectedActionV2Schema, RPC_METHODS } = await import('@happier-dev/protocol');
    const { DaemonPluginStructuredMessageActionExecuteRequestSchema } = await import('@happier-dev/protocol/plugins/actions/daemonInvocationV1');
    const selected = readPluginAccountAvailability(lifetime.scope).readCurrentAccountExecution('happier.fixture');
    if (selected.kind !== 'available' || selected.sourceCustody.kind !== 'bundled_first_party') throw new Error('Expected admitted Account bundle');
    const { computePluginAccountBundledDeclarationDigestV1 } = await import('@happier-dev/protocol/plugins/availability');
    const origin = { ...lifetime.scope, custodyId: selected.custodyId, sourceCustody: selected.sourceCustody,
        declarationDigest: computePluginAccountBundledDeclarationDigestV1(selected.manifest) };
    const projected = await readMountedAccountTargetedContributions({ pluginId: 'happier.fixture', origin,
        accountLifetime: lifetime, signal: new AbortController().signal, isCurrent: lifetime.isCurrent });
    const surface = projected.targetedContributions.points[0]!.protocols[0]!.contributions[0]!.surfaces[0]!;
    const request = readTargetedPluginSurfaceReactMountRequest({ presentation: { surface, input: { id: 'personal' } },
        target: projected.targetedContributions.target, mounts: prepareTargetedSurfaceMounts(projected.targetedSurfaceMounts) });
    if (!request) throw new Error('Expected exact admitted child');
    const provider = PluginProjectedActionV2Schema.parse({ id: 'list', pluginId: 'acme.provider-source',
        occurrenceId: 'provider-current', title: 'List', scopes: ['global'], surfaces: ['plugin'], placementBindings: [], dangerLevel: 'safe',
        execution: { target: 'daemon' }, available: true, executionOrigin: { serverIdentityId: 'srv_account_child',
            sourceRef: { machineId, pluginId: 'acme.provider-source', sourceCustody: { kind: 'development', registeredRootId: 'provider-root' } } },
        authorization: { generation: { targetGeneration: 'provider-current', desiredGeneration: 'provider-current', appliedGeneration: 'provider-current' },
            resourceSelections: [], scopedGrants: [], serviceAvailability: [], operatingSystemAuthorization: [] } });
    const pluginProjectionV2 = { v: 2 as const, generation: 1, installedPackagesById: {}, agentsById: {},
        actionsById: { 'acme.provider-source/list': provider }, toolsById: {}, commandsById: {}, resourcesById: {}, settingsById: {}, diagnostics: [], familiesById: {} };
    const invocations: ReturnType<typeof DaemonPluginStructuredMessageActionExecuteRequestSchema.parse>[] = [];
    packaged.machineRpc.mockImplementation(rpc => {
        if (rpc.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) return { ok: true, inputSchema: { type: 'object', additionalProperties: false } };
        if (rpc.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) {
            invocations.push(DaemonPluginStructuredMessageActionExecuteRequestSchema.parse(rpc.payload));
            return { ok: true, result: { rows: ['provider'] } };
        }
        throw new Error(`Unexpected Machine method ${rpc.method}`);
    });
    let transportCurrent = true;
    const screen = await renderWithAppProviders(<AppShellPluginUiProjectionProvider>
        <PluginSurfaceHost targetedMount={{ request, physicalTarget: { kind: 'app' }, parentLifetime: lifetime,
            pluginProjectionV2, daemonProjectionReady: withMachine, isExecutionOriginCurrent: () => transportCurrent }}
            machineId={withMachine ? machineId : null} serverId={lifetime.scope.serverId} platform="web" projectionInteractionEnabled />
    </AppShellPluginUiProjectionProvider>);
    try {
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.root.findAllByProps({ testID: 'account-detail-invoke' })).toHaveLength(1);
            const nested = readCurrentAppShellPluginUiProjection()?.actionsById[`happier.fixture/${nestedAction}`];
            expect(nested).toBeDefined();
            expect(nested && resolvePluginUiClientActionRegistration({ action: nested, platform: resolvePluginUiClientExecutablePlatform() })).not.toBeNull();
        });
        packaged.machineRpc.mockClear();
        await act(async () => { await screen.tree.root.findByProps({ testID: invokeTestId }).props.onPress(); });
        const result = JSON.parse(screen.tree.root.findByProps({ testID: 'account-detail-result' }).props.children);
        expect(result).toEqual(withMachine ? { rows: ['provider'] } : {
            code: reference === 'host' ? 'invalid_parameters' : 'plugin_action_machine_required',
        });
        expect(invocations).toHaveLength(withMachine ? 1 : 0);
        if (withMachine) {
            expect(invocations[0]).toMatchObject({ machineId, executionSurface: 'ui', invocation: {
                kind: 'clientPluginAction', clientActionBinding: { pluginId: 'happier.fixture', sourceCustody: { kind: 'bundled_first_party' } },
            } });
            transportCurrent = false;
            await act(async () => { await screen.tree.root.findByProps({ testID: 'account-detail-invoke' }).props.onPress(); });
            expect(invocations).toHaveLength(1);
            expect(screen.tree.root.findAllByProps({ testID: 'account-detail' })).toHaveLength(1);
            await act(async () => { await screen.tree.root.findByProps({ testID: 'account-detail-local-invoke' }).props.onPress(); });
            expect(JSON.parse(screen.tree.root.findByProps({ testID: 'account-detail-result' }).props.children))
                .toEqual({ surface: 'ui', caller: 'plugin' });
        } else expect(packaged.machineRpc).not.toHaveBeenCalled();
    } finally { await screen.unmount(); }
});

it('invokes an Account Action from the real mounted Account page without a Machine', async () => {
    await account.restore({ machines: [], features: enabledPluginFeatures, serverIdentityId: 'srv_account_page_execution' });
    const scope = storage.getState().profileScope!;
    replacePluginAccountAvailabilityProjection({ scope, snapshot: {
        availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [],
    } });
    const screen = await renderWithAppProviders(<AppPaneProvider><AppShellPluginUiProjectionProvider>
        <PluginAppPageScreen pluginId="happier.fixture" localId="account-page" subPath="" />
    </AppShellPluginUiProjectionProvider></AppPaneProvider>);
    try {
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.root.findAllByProps({ testID: 'account-page-invoke' })).toHaveLength(1);
        });
        const action = readCurrentAppShellPluginUiProjection()?.actionsById['happier.fixture/read'];
        expect(action).toBeDefined();
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(action && resolvePluginUiClientActionRegistration({ action, platform: resolvePluginUiClientExecutablePlatform() })).not.toBeNull();
        });
        packaged.machineRpc.mockClear();
        await act(async () => { await screen.tree.root.findByProps({ testID: 'account-page-invoke' }).props.onPress(); });
        expect(screen.tree.root.findByProps({ testID: 'account-page-result' }).props.children)
            .toBe(JSON.stringify({ surface: 'ui', caller: 'plugin' }));
        expect(packaged.machineRpc).not.toHaveBeenCalled();
    } finally { await screen.unmount(); }
});

it('mounts the admitted Account source detail from the real Account page without a Machine', async () => {
    await account.restore({ machines: [], features: enabledPluginFeatures, serverIdentityId: 'srv_account_source_detail' });
    const scope = storage.getState().profileScope!;
    replacePluginAccountAvailabilityProjection({ scope, snapshot: {
        availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [],
    } });
    packaged.machineRpc.mockClear();
    const screen = await renderWithAppProviders(<AppPaneProvider><AppShellPluginUiProjectionProvider>
        <PluginAppPageScreen pluginId="happier.fixture" localId="account-page" subPath="" />
    </AppShellPluginUiProjectionProvider></AppPaneProvider>);
    try {
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.root.findAllByProps({ testID: 'host-bundled-account-page' })).toHaveLength(1);
        });
        expect(JSON.stringify(screen.tree.toJSON())).toContain('Personal Account detail');
        expect(packaged.machineRpc).not.toHaveBeenCalled();
    } finally { await screen.unmount(); }
});

it('recovers an already-open page as Account binding and Availability hydrate without remounting the route', async () => {
    clearPluginAccountAvailabilityProjection();
    const screen = await renderWithAppProviders(<AppPaneProvider><AppShellPluginUiProjectionProvider>
        <PluginAppPageScreen pluginId="happier.fixture" localId="account-page" subPath="" />
    </AppShellPluginUiProjectionProvider></AppPaneProvider>);
    try {
        expect(screen.tree.root.findAllByProps({ testID: 'host-bundled-account-page' })).toHaveLength(0);
        await act(async () => {
            await account.restore({ machines: [], features: enabledPluginFeatures, serverIdentityId: 'srv_bundled_account_page' });
        });
        const scope = storage.getState().profileScope!;
        await act(async () => {
            replacePluginAccountAvailabilityProjection({ scope, snapshot: {
                availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [],
            } });
        });
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.root.findAllByProps({ testID: 'host-bundled-account-page' }), JSON.stringify(screen.tree.toJSON())).toHaveLength(1);
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
        expect(screen.tree.root.findAllByProps({ testID: 'plugin-app-page-unavailable' }).length).toBeGreaterThan(0);
    } finally { await screen.unmount(); }
});

it('opens a private plugin Inbox notice through the existing admitted plugin page host', async () => {
    await account.restore({ machines: [], features: enabledPluginFeatures, serverIdentityId: 'srv_bundled_account_page' });
    const scope = storage.getState().profileScope!;
    replacePluginAccountAvailabilityProjection({ scope, snapshot: {
        availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [],
    } });
    const notice = createAccountNoticeArtifactFixture({ ownerAccountId: scope.accountId,
        header: { source: { kind: 'plugin', pluginId: 'happier.fixture', itemId: 'review' }, page: { pageId: 'account-page' } },
    });
    storage.setState({ artifacts: { [notice.id]: notice }, isDataReady: true });
    const { InboxModelProvider } = await import('@/hooks/inbox/useInboxModel');
    const { InboxItemDetail } = await import('@/components/inbox/detail/InboxItemDetail');
    const screen = await renderWithAppProviders(<AppPaneProvider><AppShellPluginUiProjectionProvider>
        <InboxModelProvider><InboxItemDetail focus={{ kind: 'notice', serverId: scope.serverId, id: notice.id }} onClose={() => {}} /></InboxModelProvider>
    </AppShellPluginUiProjectionProvider></AppPaneProvider>);
    try {
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.root.findAllByProps({ testID: 'host-bundled-account-page' }), JSON.stringify(screen.tree.toJSON())).toHaveLength(1);
        });
        expect(screen.tree.root.findAllByProps({ testID: 'inbox.detail' })).toHaveLength(1);
    } finally { await screen.unmount(); }
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

it('renders a cold bundled Account page with shared state across navigation chrome changes and no daemon calls', async () => {
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
    const renderPage = (showsBack: boolean) => <NavigationTitleChromeProvider showsTitle={showsBack} showsBack={showsBack}>
        <AppShellPluginUiProjectionProvider><Page /></AppShellPluginUiProjectionProvider>
    </NavigationTitleChromeProvider>;
    const reactErrors = vi.spyOn(console, 'error');
    const screen = await renderWithAppProviders(renderPage(false));
    try {
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.root.findAllByProps({ testID: 'host-bundled-account-page' }), JSON.stringify(screen.tree.toJSON())).toHaveLength(1);
            expect(screen.tree.root.findAllByProps({ testID: 'host-bundled-shared-scope-ready' })).toHaveLength(1);
        });
        const admission = (await import('./projection')).readPluginAccountAvailability(scope).readCurrentAccountExecution('happier.fixture');
        expect(admission.kind).toBe('available');
        expect(screen.tree.root.findByType(PluginSurfacePlacementHost).props.placement.occurrenceId)
            .toBe(admission.kind === 'available' ? admission.custodyId : undefined);
        const mountedContent = screen.tree.root.findByProps({ testID: 'host-bundled-shared-scope-ready' });
        for (const showsBack of [true, false]) {
            await expect(screen.update(renderPage(showsBack))).resolves.toBeUndefined();
            expect(screen.tree.root.findByProps({ testID: 'host-bundled-shared-scope-ready' })).toBe(mountedContent);
        }
        expect(reactErrors.mock.calls.filter(args => args.some(value => typeof value === 'string'
            && /change in the order of Hooks|Rendered (?:more|fewer) hooks|Should have a queue/i.test(value)))).toEqual([]);
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

it('keeps the Account page usable when its optional contribution points belong to an unavailable Machine', async () => {
    const machineId = 'machine-asleep';
    await account.restore({ machines: [createMachineFixture({ id: machineId, active: false, activeAt: 0 })],
        features: enabledPluginFeatures, serverIdentityId: 'srv_bundled_account_page' });
    const scope = storage.getState().profileScope!;
    replacePluginAccountAvailabilityProjection({ scope, snapshot: {
        availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [],
    } });
    // The same canonical wire normalizer and union used by the shell retain
    // the daemon's point declaration. Neither grants executable authority.
    const sourceCustody = { kind: 'development' as const, registeredRootId: 'fixture-source' };
    const executionOrigin = { serverIdentityId: 'srv_bundled_account_page',
        sourceRef: { machineId, pluginId: 'happier.fixture', sourceCustody } };
    const runtime = normalizePluginUiProjection({ v: 2, generation: 1, agentsById: {}, actionsById: {},
        toolsById: {}, commandsById: {}, resourcesById: {}, settingsById: {}, diagnostics: [],
        installedPackagesById: { 'happier.fixture': { id: 'happier.fixture', displayName: 'Fixture', version: '1.0.0',
            enabled: true, source: { kind: 'localPath', locator: 'fixture-source' }, occurrenceId: 'fixture-occurrence',
            sourceCustody, executionOrigin,
            declaresContributionPoints: true } },
        familiesById: { pluginUi: { family: 'pluginUi',
            entriesById: Object.fromEntries(Object.entries(BUNDLED_PLUGIN_UI_APP_ARTIFACTS[0]!.uiDeclaration!.entriesById)
                .map(([id, entry]) => [id, { ...entry, occurrenceId: 'fixture-occurrence', executionOrigin }])) } },
    });
    const offline = unionPluginUiProjections([{ machineId, serverId: account.serverId,
        serverIdentityId: 'srv_bundled_account_page', projection: runtime, phase: 'retainedOffline', interactionEnabled: false }]);
    function Page() {
        const shell = useAppShellPluginUiProjection();
        const projection = mergeInstalledPluginUiProjections(shell.pluginUiProjection ? [shell.pluginUiProjection] : [], offline.pluginUiProjection);
        const placement = projection?.surfacePlacementsById['surfacePlacement:happier.fixture:account-page'];
        if (placement) expect(projection?.installedPackagesById['happier.fixture']?.declaresContributionPoints).toBe(true);
        return placement ? <PluginSurfacePlacementHost placement={placement} pluginUiProjection={projection}
            machineId={null} serverId={null} platform="web" projectionInteractionEnabled /> : null;
    }
    const screen = await renderWithAppProviders(<AppShellPluginUiProjectionProvider><Page /></AppShellPluginUiProjectionProvider>);
    try {
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.tree.root.findAllByProps({ testID: 'host-bundled-account-page' }), JSON.stringify(screen.tree.toJSON())).toHaveLength(1);
        });
        expect(screen.tree.root.findAllByProps({ 'data-plugin-interaction-state': 'enabled' }).length).toBeGreaterThan(0);
        expect(screen.tree.root.findAllByProps({ 'data-plugin-interaction-state': 'offline-snapshot' })).toHaveLength(0);
    } finally { await screen.unmount(); }
});
