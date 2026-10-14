import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { AccountProfileSchema, PluginProjectionV2Schema, RPC_METHODS, TargetedActionRpcRequestV1Schema, type PublicActionInputById } from '@happier-dev/protocol';
import { flushHookEffects, renderScreen as renderBaseScreen, standardCleanup } from '@/dev/testkit';
import { HappierInputField } from '@happier-dev/plugin-ui/presentation';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { USAGE_QUERY_INPUT_FIELDS } from '@happier-dev/protocol/inputs/usageQuery';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installSessionActionFixture } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { widgetProjectionEntry } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

// Only the daemon transport is replaced: Account admission, the catalog, executor,
// draft binding and options demand all remain real.
const discovery = vi.hoisted(() => ({ requests: [] as PublicActionInputById['action.options.resolve'][], wait: null as (() => Promise<void>) | null }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async (args: { method: string; payload: unknown }) => {
        if (args.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)
            return { protocolVersion: 1, projection: projectionWire };
        if (args.method !== 'action.options.resolve') throw new Error(`Unexpected daemon RPC: ${args.method}`);
        const targeted = TargetedActionRpcRequestV1Schema.safeParse(args.payload);
        const input = (await import('@happier-dev/protocol/actions')).PUBLIC_ACTION_INPUT_SCHEMAS['action.options.resolve'].parse(targeted.success ? targeted.data.input : args.payload);
        discovery.requests.push(input);
        await discovery.wait?.();
        const selected = input.consumer?.kind === 'widget' ? input.consumer.selectedSession?.sessionId : undefined;
        return { actionId: 'widgets.item.add', fieldPath: input.fieldPath ?? null, optionsSourceId: null,
            options: [{ value: 'choice', label: `${selected ?? 'ambient'}:${input.draftInput?.filter ?? 'none'}` }] };
    },
}));
installDisconnectedServerSocketBoundary();
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const { buildWidgetCandidateSetup } = await import('@/components/widgets/surface/widgetSurfaceSetup');
const { buildWidgetGroupInputsCandidate } = await import('@/components/widgets/group/widgetGroupInputs');
const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
const { WidgetSetupStep } = await import('./WidgetSetupStep');
const { WidgetSetupFieldRow } = await import('./WidgetSetupFieldRow');
const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
const { WidgetPreviewStage } = await import('@/components/widgets/flow/WidgetPreviewStage');
const { storage } = await import('@/sync/domains/state/storage');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const { normalizePluginUiProjection } = await import('@/sync/domains/plugins/ui/projection');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let releaseLoader: (() => void) | undefined;
let projectionWire: ReturnType<typeof PluginProjectionV2Schema.parse>;
let scope: WidgetSurfaceRefV1;
beforeEach(async () => {
    await homes.reset();
    const serverId = await homes.addHome({ name: 'Setup', serverUrl: 'https://setup-home.test', accountId: 'me' });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://setup-home.test', accountId: 'me', request: homes.request });
    scope = { serverId: connection.home.id, accountId: 'me', owner: { kind: 'home' } };
    for (const id of ['A', 'B']) installSessionActionFixture({ homes, storage, serverId, session: { id } });
    storage.setState({ machines: { machine_1: createMachineFixture({ id: 'machine_1', active: true, activeAt: Date.now() }) },
        profile: AccountProfileSchema.parse({ id: 'me', connectedAccountsV4: [{ ref: { service: { pluginId: 'acme.options', localId: 'cloud' }, accountId: 'mine' },
            status: 'connected', authenticationModeId: 'token', configurationReady: true, configurationRevision: null,
            revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', scopes: [] }] }) });
    const consumer = { pluginId: 'acme.options', localId: 'checks' };
    const entries = [{ ...widgetProjectionEntry({ ...candidate.surface!, target: 'session', inputs: { fields: [
        ...candidate.inputs!.fields, { path: 'connection', title: 'Connection', widget: 'select', connectedAccountOptions: true },
    ] }, inputSchema: { type: 'object', properties: { session: { type: 'object' }, filter: { type: 'string' }, result: { type: 'string' },
        connection: { type: 'object', required: ['service', 'accountId'], additionalProperties: false, properties: {
            service: { type: 'object', required: ['pluginId', 'localId'], additionalProperties: false,
                properties: { pluginId: { type: 'string' }, localId: { type: 'string' } } }, accountId: { type: 'string' },
        } } } }, resources: [consumer] }),
        connectedAccountPurposeBindings: [{ path: 'connection', purpose: 'metrics', consumer }] },
    widgetProjectionEntry({ pluginId: 'acme.options', localId: 'first', target: 'app', inputs: { fields: [
        { path: 'period', title: 'Period', widget: 'select', inputType: { pluginId: 'acme.options', localId: 'choice' } },
        { path: 'result', title: 'Owned result', widget: 'select', inputType: { pluginId: 'acme.options', localId: 'choice' }, contextMode: 'own' },
    ] }, inputSchema: { type: 'object', properties: { period: { type: 'string' }, result: { type: 'string' } }, additionalProperties: false } })];
    projectionWire = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
        installedPackagesById: { 'acme.options': { id: 'acme.options', displayName: 'Options', enabled: true,
            occurrenceId: 'acme.options#1', source: { kind: 'local', locator: '/plugins/acme.options' } } },
        familiesById: { pluginUi: { family: 'pluginUi', entriesById: Object.fromEntries(entries.map(entry => [entry.id, entry])) } },
        resourcesById: { checks: { id: 'checks', pluginId: 'acme.options', resourceKind: 'config', scope: 'global',
            connectedAccountPurposes: [{ purpose: 'metrics', serviceRefs: [{ pluginId: 'acme.options', localId: 'cloud' }] }] } } });
    clearDaemonMergedProjectionCacheForTests();
    releaseLoader = await installRealActionExecutorModuleLoader();
});
afterEach(async () => {
    standardCleanup(); discovery.requests = []; discovery.wait = null; releaseLoader?.(); releaseLoader = undefined;
    clearDaemonMergedProjectionCacheForTests(); await connection?.dispose(); connection = undefined;
});
function renderScreen(element: React.ReactElement) {
    return renderBaseScreen(<AppShellPluginUiProjectionValueProvider value={{
        pluginUiProjection: normalizePluginUiProjection(projectionWire), pluginBrowserProjection: null, phase: 'current', interactionEnabled: true,
        machineId: 'machine_1', serverId: scope.serverId, platform: 'web', accountLifetime: captureActiveServerAccountScopeLifetime(),
        reloadConnectedAccountProjection: () => {}, clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {},
    }}>{element}</AppShellPluginUiProjectionValueProvider>);
}

const candidate: WidgetCandidate = { key: 'acme.options/checks', title: 'Checks', pluginName: 'Options', sharedPluginName: false,
    icon: 'squares-four', homeDefault: 'available', target: 'session', sessionInputPath: 'session',
    sizeDeclaration: { sizes: ['small', 'medium', 'wide', 'full', 'tall', 'large'], defaultSize: 'medium' },
    surface: { pluginId: 'acme.options', localId: 'checks' }, inputs: { fields: [
        { path: 'session', title: 'Session', widget: 'json', required: true },
        { path: 'filter', title: 'Filter', widget: 'text' },
        { path: 'result', title: 'Result', widget: 'select', required: true, inputType: { pluginId: 'acme.options', localId: 'choice' } },
    ] } };

describe('WidgetSetupStep discovery', () => {
    it('does not claim a mounted error preview is live data when its inputs resolve', async () => {
        const setup = buildWidgetCandidateSetup({ candidate: { ...candidate, target: 'app', sessionInputPath: undefined, inputs: { fields: [] } },
            scope, audience: 'personal', context: {}, mode: { kind: 'add', submitLabel: 'Add' }, submit: async () => ({ ok: true }),
            renderPreview: () => <SurfaceStateCard kind="error" replacesContent title="Read failed" /> });
        const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false} presentation="pane" onDone={() => {}} testID="read-failed" />);
        // Sized widget bodies mount after their real viewport has been measured.
        await act(async () => { screen.findByTestId('read-failed.previewCard.viewport')!.props.onLayout({
            nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 200 } },
        }); });
        expect(screen.root.findAllByType(SurfaceStateCard).some(node => node.props.kind === 'error')).toBe(true);
        expect(screen.root.findByType(WidgetPreviewStage).props.live).not.toBe(true);
        expect(screen.findByTestId('read-failed.preview.live')).toBeNull();
        expect(screen.root.findByType(WidgetPreviewStage).props.caption).toBe('widgetAdd.preview');
    });

    it('shows an unreachable Home while a dispatched save remains pending, then accepts its actual receipt', async () => {
        const previous = storage.getState();
        const applied = getAppliedActiveServerSnapshot();
        const available = isAppliedActiveServerRuntimeAvailable();
        let finish!: (value: { ok: true }) => void;
        const completed = vi.fn();
        const setup = buildWidgetCandidateSetup({ candidate: { ...candidate, target: 'app', sessionInputPath: undefined, inputs: { fields: [] } },
            scope: { ...scope, owner: { kind: 'home' } }, audience: 'personal', context: {},
            mode: { kind: 'add', submitLabel: 'Add' }, submit: async () => new Promise(resolve => { finish = resolve; }) });
        publishAppliedActiveServerSnapshot({ serverId: scope.serverId, serverUrl: 'https://setup-home.test', generation: 1 });
        storage.setState({ endpointStatus: 'online', socketStatus: 'connected' });
        const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false} serverId={scope.serverId}
            onDone={completed} testID="pending-home" />);
        try {
            await act(async () => { screen.findByTestId('pending-home.submit')!.props.onPress(); });
            await act(async () => { storage.setState({ endpointStatus: 'offline' }); });
            expect(screen.findByTestId('pending-home.why')!.props.children).toBe('settingsPlugins.targetSelection.unreachableThisHome');
            expect(screen.findByTestId('pending-home.submit')!.props.disabled).toBe(true);
            expect(screen.findAllByType(RoundButton).find(node => node.props.testID === 'pending-home.submit')!.props.loading).toBe(false);
            expect(completed).not.toHaveBeenCalled();
            await act(async () => { finish({ ok: true }); });
            expect(completed).toHaveBeenCalledWith({ ok: true });
        } finally {
            await screen.unmount();
            storage.setState(previous, true);
            publishAppliedActiveServerSnapshot(applied, available);
        }
    });
    it.each([[{}, false], [{ slots: { session: { label: 'This session', value: null } } }, true]] as const)(
        'shows the Usage Session input from actual host slot declarations: %j', async (context, expected) => {
            const sessionField = USAGE_QUERY_INPUT_FIELDS.find(field => field.path === 'session')!;
            const queryCandidate: WidgetCandidate = { ...candidate, target: 'app', sessionInputPath: undefined,
                inputs: { fields: [sessionField] } };
            const setup = buildWidgetCandidateSetup({ candidate: queryCandidate, scope, audience: 'personal', context,
                mode: { kind: 'edit', instance: { v: 1, id: 'query', definition: { kind: 'installed', surface: candidate.surface! },
                    bindings: { session: { kind: 'value', value: ['retained-pin'] } } } }, submit: async () => ({ ok: true }) });
            const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false} serverId={scope.serverId}
                onDone={() => {}} testID="query-scope" />);
            expect(screen.findAllByType(WidgetSetupFieldRow).some(row => row.props.entry.field.path === 'session')).toBe(expected);
            expect(setup.initial.bindings.session).toEqual({ kind: 'value', value: ['retained-pin'] });
        });
    it('sends a group field read with its own declaring child identity', async () => {
        const first: WidgetCandidate = { ...candidate, target: 'app', sessionInputPath: undefined,
            surface: { pluginId: 'acme.options', localId: 'first' },
            inputs: { fields: [{ path: 'period', title: 'Period', widget: 'select', inputType: { pluginId: 'acme.options', localId: 'choice' } },
                { path: 'result', title: 'Owned result', widget: 'select', inputType: { pluginId: 'acme.options', localId: 'choice' }, contextMode: 'own' }] } };
        const children = [first, candidate];
        const setup = buildWidgetCandidateSetup({ candidate: buildWidgetGroupInputsCandidate({ title: 'Group', candidates: children })!,
            fieldCandidates: children, scope, audience: 'personal', context: {},
            mode: { kind: 'edit', instance: { v: 1, id: 'group', definition: { kind: 'installed', surface: first.surface! },
                bindings: { session: { kind: 'value', value: { serverId: scope.serverId, sessionId: 'B' } } } } },
            submit: async () => ({ ok: true }) });
        const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false} serverId={scope.serverId}
            onDone={() => {}} testID="group-discovery" />);
        await vi.waitFor(() => expect(discovery.requests.find(request => request.fieldPath === 'result')).toMatchObject({
            consumer: { kind: 'widget', definition: { kind: 'installed', surface: candidate.surface },
                selectedSession: { serverId: scope.serverId, sessionId: 'B' } },
        }));
        expect(discovery.requests.find(request => request.fieldPath === 'period')).toMatchObject({
            consumer: { definition: { kind: 'installed', surface: first.surface } },
        });
        expect(screen.findAllByType(WidgetSetupFieldRow).filter(row => row.props.entry.field.path === 'result')).toHaveLength(1);
        expect(screen.findAllByType(HappierInputField).find(row => row.props.field.path === 'result')!.props.options)
            .toEqual([expect.objectContaining({ value: 'choice', label: 'B:none' })]);
    });
    it('names the picked value immediately while the new draft options read is held', async () => {
        const setup = buildWidgetCandidateSetup({ candidate, scope, audience: 'personal', context: {},
            mode: { kind: 'edit', instance: { v: 1, id: 'labels', definition: { kind: 'installed', surface: candidate.surface! },
                bindings: { session: { kind: 'value', value: { serverId: scope.serverId, sessionId: 'A' } } } } },
            submit: async () => ({ ok: true }) });
        const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false} serverId={scope.serverId}
            onDone={() => {}} testID="picked-label" />);
        const row = () => screen.findAllByType(WidgetSetupFieldRow).find(row => row.props.entry.field.path === 'result')!;
        await vi.waitFor(() => expect(row().props.options).toEqual([expect.objectContaining({ value: 'choice', label: 'A:none' })]));
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        discovery.wait = () => held;
        try {
            await act(async () => { row().props.onChange({ kind: 'pin', value: 'choice' }); });
            expect(row().props.optionsStatus).toBe('loading');
            expect(row().props.row).toMatchObject({ kind: 'pinned', label: 'A:none' });
            expect(screen.findAllByType(HappierInputField).find(field => field.props.field.path === 'result')!.props.valueLabel).toBe('A:none');
        } finally { release(); await screen.unmount(); }
    });

    it('does not write when a ready size-only setup is cancelled', async () => {
        const submit = vi.fn(async () => ({ ok: true as const }));
        const cancel = vi.fn();
        const setup = buildWidgetCandidateSetup({ candidate: { ...candidate, target: 'app', sessionInputPath: undefined, inputs: { fields: [] } },
            scope: { ...scope, owner: { kind: 'home' } }, audience: 'personal', context: {},
            mode: { kind: 'add', submitLabel: 'Add' }, submit });
        expect(setup.resolve(setup.initial).status).toBe('ready');
        const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false}
            onCancel={cancel} onDone={() => {}} testID="size-only" />);
        await screen.pressByTestIdAsync('size-only.size.large');
        await screen.pressByTestIdAsync('size-only.cancel');
        expect(cancel).toHaveBeenCalledOnce();
        expect(submit).not.toHaveBeenCalled();
    });
    it('names what the footer is doing while the Add is in flight, beside the button spinner', async () => {
        let finish!: (value: { ok: true }) => void;
        const setup = buildWidgetCandidateSetup({ candidate: { ...candidate, target: 'app', sessionInputPath: undefined, inputs: { fields: [] } },
            scope: { ...scope, owner: { kind: 'home' } }, audience: 'personal', context: {},
            mode: { kind: 'add', submitLabel: 'Add' }, submit: async () => new Promise(resolve => { finish = resolve; }) });
        const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false} presentation="pane" onDone={() => {}} testID="adding-pane" />);
        await act(async () => { screen.findByTestId('adding-pane.submit')!.props.onPress(); });
        expect(screen.findAllByType(RoundButton).find(node => node.props.testID === 'adding-pane.submit')!.props.loading).toBe(true);
        expect(screen.findByTestId('adding-pane.why')!.props.children).toBe('widgetAdd.adding');
        await act(async () => { finish({ ok: true }); });
        await screen.unmount();
    });

    it('offers another copy rather than the same Add again once the Add pane has added', async () => {
        const submit = vi.fn(async () => ({ ok: true as const }));
        const setup = buildWidgetCandidateSetup({ candidate: { ...candidate, target: 'app', sessionInputPath: undefined, inputs: { fields: [] } },
            scope: { ...scope, owner: { kind: 'home' } }, audience: 'personal', context: {},
            mode: { kind: 'add', submitLabel: 'Add to Home' }, submit });
        const label = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.findAllByType(RoundButton).find(node => node.props.testID === 'added-pane.submit')!.props.title;
        const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false} presentation="pane" onDone={() => {}} testID="added-pane" />);
        expect(label(screen)).toBe('Add to Home');
        await screen.pressByTestIdAsync('added-pane.submit');
        expect(submit).toHaveBeenCalledOnce();
        expect(label(screen)).toBe('widgetAdd.addAnother');
        await screen.pressByTestIdAsync('added-pane.submit');
        expect(submit).toHaveBeenCalledTimes(2);
        await screen.unmount();
    });

    it('previews the chosen declared size and submits it together with the input bindings', async () => {
        const sized: WidgetCandidate = { ...candidate, target: 'app', sessionInputPath: undefined,
            inputs: { fields: [{ path: 'filter', title: 'Filter', widget: 'text' as const, required: true }] },
            sizeDeclaration: { sizes: ['large', 'small', 'medium'], defaultSize: 'medium' } };
        const previews: unknown[] = [];
        const submit = vi.fn(async () => ({ ok: true as const }));
        const setup = buildWidgetCandidateSetup({ candidate: sized, scope: { ...scope, owner: { kind: 'home' } },
            audience: 'personal', context: {}, mode: { kind: 'add', submitLabel: 'Add' }, submit,
            renderPreview: ({ draft }) => { previews.push(draft); return null; } });
        const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false}
            onCancel={() => {}} onDone={() => {}} testID="size-setup" />);
        expect(screen.findByTestId('size-setup.size.small')).not.toBeNull();
        await screen.pressByTestIdAsync('size-setup.size.large');
        await act(async () => { screen.changeTextByTestId('size-setup.field.filter.input', 'open'); });
        await screen.pressByTestIdAsync('size-setup.submit');
        expect(previews.at(-1)).toEqual({ size: 'large', bindings: { filter: { kind: 'value', value: 'open' } } });
        expect(submit).toHaveBeenCalledWith({ size: 'large', bindings: { filter: { kind: 'value', value: 'open' } } });
    });

    it('accepts a typed JSON literal without discovery through the public field parser and binder', async () => {
        const literal: WidgetCandidate = { ...candidate, target: 'app', sessionInputPath: undefined,
            inputs: { fields: [{ path: 'filter', title: 'Filter', widget: 'json', required: true,
                inputType: { pluginId: 'acme.options', localId: 'filter' } }] },
            inputSchema: { type: 'object', properties: { filter: { type: 'object', properties: { branch: { type: 'string' } },
                required: ['branch'], additionalProperties: false } }, required: ['filter'], additionalProperties: false } };
        const submit = vi.fn(async () => ({ ok: true as const }));
        const setup = buildWidgetCandidateSetup({ candidate: literal, scope, audience: 'personal', context: {},
            mode: { kind: 'add', submitLabel: 'Add' }, submit });
        const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false} serverId={scope.serverId}
            onCancel={() => {}} onDone={() => {}} testID="literal" />);
        expect(screen.findByTestId('literal.submit')!.props.disabled).toBe(true);
        expect(screen.findByTestId('literal.field.filter.input')).not.toBeNull();
        await act(async () => { screen.changeTextByTestId('literal.field.filter.input', '{"branch":"main"}'); });
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByTestId('literal.submit')!.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('literal.submit');
        expect(submit).toHaveBeenCalledWith({ size: 'medium', bindings: { filter: { kind: 'value', value: { branch: 'main' } } } });
        expect(discovery.requests).toHaveLength(0);
    });

    it('discovers against the current pinned Session and refreshes dependent options when the draft changes', async () => {
        const setup = buildWidgetCandidateSetup({ candidate, scope, audience: 'personal', context: {
            session: { ref: { serverId: scope.serverId, sessionId: 'A' }, label: 'A' },
        }, mode: { kind: 'add', submitLabel: 'Add' }, submit: async () => ({ ok: true }) });
        const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false} serverId={scope.serverId} sessionId="A"
            onCancel={() => {}} onDone={() => {}} testID="setup" />);
        await flushHookEffects({ cycles: 4 });
        const change = async (path: string, value: Parameters<React.ComponentProps<typeof WidgetSetupFieldRow>['onChange']>[0]) => {
            await act(async () => { screen.findAllByType(WidgetSetupFieldRow).find(row => row.props.entry.field.path === path)!.props.onChange(value); });
            await flushHookEffects({ cycles: 4 });
        };
        await change('session', { kind: 'pin', value: { serverId: scope.serverId, sessionId: 'B' } });
        await change('filter', { kind: 'pin', value: 'open' });
        const request = discovery.requests.filter(request => request.fieldPath === 'result').at(-1)!;
        expect(request.consumer).toMatchObject({ kind: 'widget', selectedSession: { serverId: scope.serverId, sessionId: 'B' } });
        expect(request.draftInput).toMatchObject({ session: { serverId: scope.serverId, sessionId: 'B' }, filter: 'open' });
        const options = screen.findAllByType(HappierInputField).find(row => row.props.field.path === 'result')!.props.options;
        expect(options[0]?.label).toBe('B:open');
    });

    it('discovers connection-only options for a personal field without making a shared viewer field selectable', async () => {
        const personal = { ...candidate, target: 'app' as const, sessionInputPath: undefined, inputs: { fields: [
            { path: 'connection', title: 'Connection', widget: 'select' as const, required: true, connectedAccountOptions: true as const },
        ] }, connectedAccountPurposeBindings: [{ path: 'connection', purpose: 'metrics', consumer: { pluginId: 'acme.options', localId: 'checks' } }] };
        const setup = buildWidgetCandidateSetup({ candidate: personal, scope, audience: 'personal', context: {},
            mode: { kind: 'add', submitLabel: 'Add' }, submit: async () => ({ ok: true }) });
        const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false} serverId={scope.serverId}
            onCancel={() => {}} onDone={() => {}} testID="connection" />);
        await flushHookEffects({ cycles: 4 });
        await vi.waitFor(() => expect(screen.findAllByType(HappierInputField).find(row => row.props.field.path === 'connection')!.props.options)
            .toEqual([expect.objectContaining({ value: { service: { pluginId: 'acme.options', localId: 'cloud' }, accountId: 'mine' } })]));
        expect(buildWidgetCandidateSetup({ candidate: personal, scope: { ...scope, owner: { kind: 'sessionBoard', sessionId: 'A' } },
            audience: 'shared', context: {}, mode: { kind: 'add', submitLabel: 'Add' }, submit: async () => ({ ok: true }) }).fields[0]?.viewer)
            .toEqual({ purpose: 'metrics' });
    });
});

describe('WidgetSetupStep on a phone', () => {
    it('keeps a visible dismiss in Edit inputs: the header caret closes the sheet when there is no step to go back to', async () => {
        const close = vi.fn();
        const setup = buildWidgetCandidateSetup({ candidate, scope, audience: 'personal', context: {
            session: { ref: { serverId: scope.serverId, sessionId: 'A' }, label: 'A' },
        }, mode: { kind: 'edit', instance: { v: 1, id: 'copy', definition: { kind: 'installed', surface: candidate.surface! }, bindings: {} } },
        submit: async () => ({ ok: true }) });
        const screen = await renderScreen(<WidgetSetupStep setup={setup} phone serverId={scope.serverId}
            onCancel={() => {}} onClose={close} onDone={() => {}} testID="edit" />);
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByTestId('edit.back')).toBeNull();
        await screen.pressByTestIdAsync('edit.close');
        expect(close).toHaveBeenCalledTimes(1);
    });
});
