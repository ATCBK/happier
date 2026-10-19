/** @vitest-environment jsdom */
import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBrowserStorageLockBoundary, renderScreen, standardCleanup } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { CompactAppDestination } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { createWorkspaceState, reduceWorkspaceState, type WorkspaceState } from './workspaceState';
import { registerWorkspaceRouteContext } from './workspaceRouteContext';

installPanelCommonModuleMocks();
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => '/', params: () => ({}) }).module;
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: true }).module;
});
// Expo's module-loader boundary supplies the Sessions-list body used by this shell journey.
registerWorkspaceRouteContext((key) => {
    if (key !== './(app)/index.tsx') throw new Error(`Unexpected shell route: ${key}`);
    return { WorkspaceRouteBody: StatefulRouteBody };
});

let nextBodyMount = 0;
function StatefulRouteBody() {
    const tabId = useDestinationInstanceKey();
    const [mount] = React.useState(() => ++nextBodyMount);
    const [draft, setDraft] = React.useState('');
    const [viewport, setViewport] = React.useState(0);
    return React.createElement('StatefulRouteBodyProbe', { tabId, mount, draft, viewport, setDraft, setViewport });
}
// Recipient-envelope HTTP/process APIs are outside this deterministic workspace owner harness.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unavailable = () => { throw new Error('Unexpected recipient-envelope API in workspace owner test'); };
    return { createSessionDataKeyEnvelopeClient: unavailable, readSessionDataKeyEnvelopeCollectionPage: unavailable,
        prepareSessionDataKeyEnvelopesForScope: unavailable, prepareSessionDataKeyEnvelopesDetached: unavailable };
});
// The popover's portal/measurement boundary renders the open tab menu inline; the menu itself is real.
vi.mock('@/components/ui/popover', async (importOriginal) => {
    const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
    return createInlinePopoverModuleMock(importOriginal);
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

const WINDOW_ID = 'workspace-shell-test';
const loadProduction = () => Promise.all([
    import('./WorkspaceProvider'), import('./WorkspaceShell'), import('./DestinationInstanceHost'),
    import('../destinations/compactAppDestinationCatalog'), import('./workspacePersistence'),
    import('@/keyboard/KeyboardShortcutProvider'), import('@/sync/ops/actions/frontDoorRuntimeActionExecutor'),
    import('@/sync/domains/state/storage'), import('@/modal'),
]);
let production!: Awaited<ReturnType<typeof loadProduction>>;
let DestinationInstanceHost!: (Awaited<ReturnType<typeof loadProduction>>)[2]['DestinationInstanceHost'];
let useDestinationInstanceKey!: (Awaited<ReturnType<typeof loadProduction>>)[2]['useDestinationInstanceKey'];
let resolveDestinationRefFromHref!: (Awaited<ReturnType<typeof loadProduction>>)[3]['resolveDestinationRefFromHref'];
let fixture: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
let disconnect: (() => Promise<unknown>) | undefined;
let restoreLocks: (() => void) | undefined;
let baseline: ReturnType<(Awaited<ReturnType<typeof loadProduction>>)[7]['storage']['getState']> | undefined;

beforeAll(async () => {
    restoreLocks = installBrowserStorageLockBoundary();
    installDisconnectedServerSocketBoundary();
    fixture = await serveActionHomes({ homes: [{ key: 'import', serverUrl: 'https://workspace-shell-import.test', accountId: 'alice', currentAccount: true }], route: () => undefined });
    disconnect = await fixture.restoreActiveConnection();
    production = await loadProduction();
    ({ DestinationInstanceHost, useDestinationInstanceKey } = production[2]);
    ({ resolveDestinationRefFromHref } = production[3]);
    await disconnect(); disconnect = undefined;
    await fixture.dispose(); fixture = undefined;
    restoreLocks(); restoreLocks = undefined;
});
beforeEach(() => {
    baseline = production[7].storage.getState();
    window.history.replaceState(null, '', '/');
    // Session storage is the platform boundary read by useWorkspaceState's window owner.
    window.sessionStorage.setItem('happier.workspace.windowIdV1', WINDOW_ID);
    vi.mocked(production[8].Modal.alertAsync).mockClear();
});
afterEach(async () => {
    standardCleanup();
    try { await disconnect?.(); }
    finally {
        disconnect = undefined; await fixture?.dispose(); fixture = undefined;
        restoreLocks?.(); restoreLocks = undefined;
        if (baseline) production[7].storage.setState(baseline, true);
        vi.restoreAllMocks();
    }
});
afterAll(async () => { await disconnect?.(); await fixture?.dispose(); restoreLocks?.(); });

function Harness(props: Readonly<{ catalog: readonly CompactAppDestination[] }>) {
    const [{ WorkspaceProvider }, { WorkspaceShell }, , , , { KeyboardShortcutProvider }] = production;
    return <KeyboardShortcutProvider handlers={{}}><WorkspaceProvider enabled catalog={props.catalog}>{navigation => <>
        {React.createElement('WorkspaceStateProbe', { state: navigation.state, navigation })}
        <WorkspaceShell catalog={props.catalog} />
    </>}</WorkspaceProvider></KeyboardShortcutProvider>;
}

function initialState() {
    return reduceWorkspaceState(createWorkspaceState(restoredTab('a')),
        { type: 'openTab', groupId: 'group:1', tab: restoredTab('b', true) });
}

// Distinct canonical root-route anchors let initial URL admission restore the
// selected instance rather than open the separate Sessions-list preview at '/'.
function restoredTab(id: string, preview = false) {
    return { id, target: { kind: 'sessions', params: { anchor: id } }, pinned: false, preview };
}

function stateOf(screen: Awaited<ReturnType<typeof renderScreen>>): WorkspaceState {
    return screen.root.findByType('WorkspaceStateProbe').props.state;
}

async function measureContentSlots(screen: Awaited<ReturnType<typeof renderScreen>>) {
    await act(async () => {
        for (const groupId of Object.keys(stateOf(screen).groups)) {
            screen.findByTestId(`split-canvas-content-slot-${groupId}`)?.props.onLayout({
                nativeEvent: { layout: { x: 0, y: 32, width: 760, height: 820 } },
            });
        }
    });
}

async function renderWorkspace(initial: WorkspaceState) {
    restoreLocks = installBrowserStorageLockBoundary();
    installDisconnectedServerSocketBoundary();
    fixture = await serveActionHomes({ homes: [{ key: 'home', serverUrl: 'https://workspace-shell.test', accountId: 'alice', currentAccount: true,
        settings: { keyboardShortcutsV2Enabled: true } }], route: () => undefined });
    disconnect = await fixture.restoreActiveConnection();
    const { storage } = production[7];
    const scope = storage.getState().profileScope;
    if (!scope) throw new Error('Shell fixture requires the restored Account scope');
    const { serializeWorkspaceLayout, workspaceLayoutScopeKey } = production[4];
    storage.setState({ isDataReady: true, localSettings: { ...storage.getState().localSettings, workspaceLayoutV1: {
        [workspaceLayoutScopeKey({ ...scope, windowId: WINDOW_ID })]: serializeWorkspaceLayout(initial),
    } } });
    const catalog = production[3].resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
    const activeTab = initial.tabs[initial.groups[initial.focusedGroupId].activeTabId];
    const href = production[3].hrefForDestinationRef(catalog, activeTab.target);
    if (!href) throw new Error('Shell fixture requires a catalog-admitted initial route');
    window.history.replaceState(null, '', href);
    const screen = await renderScreen(<Harness catalog={catalog} />);
    await settle(() => { expect(Object.keys(stateOf(screen).tabs)).toEqual(Object.keys(initial.tabs)); });
    await measureContentSlots(screen);
    return screen;
}

async function settle(outcome: () => void) {
    await vi.waitFor(async () => { await act(async () => {}); outcome(); });
}

async function action(actionId: ActionId, input: unknown) {
    const scope = production[7].storage.getState().profileScope;
    if (!scope) throw new Error('Shell Action requires its Account scope');
    let result!: ActionExecuteResult;
    await act(async () => { result = await production[6].createFrontDoorActionExecute()(actionId, input, {
        surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: scope.serverId, expectedAccountId: scope.accountId,
    }); });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errorCode);
    return result.result;
}

/** Opens a tab's menu (press and hold) and chooses one of its items; the menu commits once closed. */
async function chooseFromTabMenu(screen: Awaited<ReturnType<typeof renderScreen>>, tabId: string, itemTestId: string, outcome: () => void) {
    const tab = screen.findAllByTestId(`workspace-tab-${tabId}`).find((node) => typeof node.props.onLongPress === 'function');
    if (!tab) throw new Error(`Tab ${tabId} offers no menu`);
    await act(async () => { tab.props.onLongPress({}); });
    await screen.pressByTestIdAsync(itemTestId);
    await settle(outcome);
    await measureContentSlots(screen);
}

function measureCanvas(screen: Awaited<ReturnType<typeof renderScreen>>, width: number, height: number) {
    const event = { nativeEvent: { layout: { width, height, x: 0, y: 0 } } };
    screen.findByTestId('split-canvas-host')?.props.onLayout(event);
    screen.findByTestId('split-canvas-leaf-interaction-surface-group:1')?.props.onLayout(event);
}

describe('WorkspaceShell', () => {
    it('shows the registered split-down shortcut in the tab menu and withdraws it when shortcuts are disabled', async () => {
        const { KeyHint } = await import('@/components/ui/keyboard/KeyHint');
        const screen = await renderWorkspace(initialState());
        const tab = screen.findAllByTestId('workspace-tab-a').find(node => typeof node.props.onLongPress === 'function');
        if (!tab) throw new Error('The workspace tab must offer its menu');
        await act(async () => { tab.props.onLongPress({}); });
        const splitHint = () => screen.findByTestId('workspace-tab-menu-split-down')?.findAllByType(KeyHint);
        expect(splitHint()?.map(node => node.props.label)).toEqual(['Alt+Shift+\\']);

        const { storage } = production[7];
        await act(async () => { storage.setState({ settings: { ...storage.getState().settings, keyboardShortcutsV2Enabled: false } }); });
        expect(screen.findByTestId('workspace-tab-menu-split-down')).not.toBeNull();
        expect(splitHint()).toEqual([]);
    });

    it('provides an accessible new-tab action and closes that tab through the registered keyboard owner', async () => {
        const screen = await renderWorkspace(initialState());
        const button = screen.findHostByTestId('workspace-new-tab-group_1');
        expect(button?.props.accessibilityLabel).toBe('workspaceBar.newTab');
        expect(button?.props.role).toBe('button');
        await screen.pressByTestIdAsync('workspace-new-tab-group_1');
        await settle(() => { expect(stateOf(screen).groups['group:1'].tabIds).toHaveLength(3); });
        expect(stateOf(screen).tabs[stateOf(screen).groups['group:1'].activeTabId].target.kind).toBe('newTab');
        const openedTab = stateOf(screen).groups['group:1'].activeTabId;
        const closeKey = new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', ctrlKey: true, bubbles: true, cancelable: true });
        await act(async () => { window.dispatchEvent(closeKey); });
        expect(closeKey.defaultPrevented).toBe(true);
        await settle(() => { expect(stateOf(screen).tabs[openedTab]).toBeUndefined(); });
        expect(stateOf(screen).groups['group:1'].tabIds).toEqual(['a', 'b']);
    });

    it('moves a singleton plugin tab into a split and leaves a new-tab target in its empty source', () => {
        const catalog: readonly CompactAppDestination[] = [{
            id: 'plugin:acme.notes:notes', kind: 'plugin', container: 'appPage',
            destination: { pluginId: 'acme.notes', localId: 'notes' },
            title: 'Notes', icon: 'note', order: 40, placement: { kind: 'rail', region: 'plugins' },
            activation: 'navigate', routePath: '/plugins/acme.notes/notes', availability: 'available',
        }];
        const target = resolveDestinationRefFromHref(catalog, '/plugins/acme.notes/notes/first');
        if (!target) throw new Error('The singleton catalog fixture must resolve its route');
        const pluginTab = { id: 'singleton-notes', target, pinned: true, preview: false };
        const state = reduceWorkspaceState(createWorkspaceState(pluginTab), {
            type: 'splitTab', tabId: pluginTab.id, sourceGroupId: 'group:1', targetGroupId: 'group:1',
            newGroupId: 'group:2', axis: 'row', placement: 'after',
            availableSizePx: 1200, minimumFirstSizePx: 420, minimumSecondSizePx: 420,
            newTabForSource: { id: 'source-new', target: { kind: 'newTab', params: {} }, pinned: false, preview: false },
        });
        expect(Object.values(state.tabs).filter((tab) => tab.target.kind === target.kind)).toEqual([pluginTab]);
        expect(state.groups['group:2'].tabIds).toEqual([pluginTab.id]);
        expect(state.groups['group:1'].tabIds).toEqual(['source-new']);
        expect(state.tabs['source-new'].target.kind).toBe('newTab');
        expect(state.focusedGroupId).toBe('group:2');
    });

    it('restores 50 tabs without mounting unopened bodies, retains visited state and releases closed bodies', async () => {
        let initial = createWorkspaceState(restoredTab('restored-0'));
        for (let index = 1; index < 50; index++) {
            initial = reduceWorkspaceState(initial, { type: 'openTab', groupId: 'group:1', tab: restoredTab(`restored-${index}`) });
        }
        const screen = await renderWorkspace(initial);
        const body = (tabId: string) => screen.root.findAllByType('StatefulRouteBodyProbe').find(node => node.props.tabId === tabId)!;
        const mountedBodies = () => screen.root.findAllByType('StatefulRouteBodyProbe').map(node => node.props.tabId);
        expect(stateOf(screen).groups['group:1'].tabIds).toHaveLength(50);
        expect(screen.root.findAllByType(DestinationInstanceHost).map((node) => node.props.tabId)).toEqual(['restored-49']);
        expect(mountedBodies()).toEqual(['restored-49']);
        const lastMount = body('restored-49').props.mount;
        await act(async () => {
            body('restored-49').props.setDraft('Keep the restored draft');
            body('restored-49').props.setViewport(387);
            screen.findByTestId('workspace-tab-restored-0')?.props.onPress();
        });
        await settle(() => { expect(stateOf(screen).groups['group:1'].activeTabId).toBe('restored-0'); });
        expect(screen.root.findAllByType(DestinationInstanceHost).map((node) => [node.props.tabId, node.props.visible, node.props.focused]))
            .toEqual([['restored-0', true, true], ['restored-49', false, false]]);
        expect(mountedBodies()).toEqual(['restored-0', 'restored-49']);
        expect(body('restored-49').props).toMatchObject({ mount: lastMount, draft: 'Keep the restored draft', viewport: 387 });
        const firstMount = body('restored-0').props.mount;
        await act(async () => {
            body('restored-0').props.setDraft('Keep the newly visited draft');
            body('restored-0').props.setViewport(92);
            screen.findByTestId('workspace-tab-restored-49')?.props.onPress();
        });
        await settle(() => { expect(stateOf(screen).groups['group:1'].activeTabId).toBe('restored-49'); });
        expect(screen.root.findAllByType(DestinationInstanceHost).map((node) => [node.props.tabId, node.props.visible, node.props.focused]))
            .toEqual([['restored-0', false, false], ['restored-49', true, true]]);
        expect(body('restored-49').props).toMatchObject({ mount: lastMount, draft: 'Keep the restored draft', viewport: 387 });
        expect(body('restored-0').props).toMatchObject({ mount: firstMount, draft: 'Keep the newly visited draft', viewport: 92 });
        await chooseFromTabMenu(screen, 'restored-0', 'workspace-tab-menu-pin', () => { expect(stateOf(screen).tabs['restored-0'].pinned).toBe(true); });
        expect(stateOf(screen).tabs['restored-0']).toMatchObject({ pinned: true, preview: false });
        await chooseFromTabMenu(screen, 'restored-49', 'workspace-tab-menu-pin', () => { expect(stateOf(screen).tabs['restored-49'].pinned).toBe(true); });
        expect(stateOf(screen).tabs['restored-49']).toMatchObject({ pinned: true, preview: false });
        await chooseFromTabMenu(screen, 'restored-0', 'workspace-tab-menu-close', () => { expect(stateOf(screen).tabs['restored-0']).toBeUndefined(); });
        expect(stateOf(screen).tabs['restored-0']).toBeUndefined();
        expect(stateOf(screen).groups['group:1'].activeTabId).toBe('restored-49');
        expect(screen.root.findAllByType(DestinationInstanceHost).map((node) => node.props.tabId)).toEqual(['restored-49']);
        expect(mountedBodies()).toEqual(['restored-49']);
        expect(body('restored-49').props).toMatchObject({ mount: lastMount, draft: 'Keep the restored draft', viewport: 387 });
    });

    it('preserves the mounted body, draft and viewport when a tab moves across groups', async () => {
        const initial = reduceWorkspaceState(createWorkspaceState(restoredTab('a')),
            { type: 'openTab', groupId: 'group:1', tab: restoredTab('b') });
        const screen = await renderWorkspace(initial);
        const body = () => screen.root.findAllByType('StatefulRouteBodyProbe').find(node => node.props.tabId === 'b')!;
        const mount = body().props.mount;
        await act(async () => {
            body().props.setDraft('Keep this unsent draft');
            body().props.setViewport(387);
            measureCanvas(screen, 1200, 800);
        });
        await chooseFromTabMenu(screen, 'b', 'workspace-tab-menu-split-right', () => { expect(Object.keys(stateOf(screen).groups)).toHaveLength(2); });
        expect(stateOf(screen).groups[stateOf(screen).focusedGroupId].tabIds).toEqual(['b']);
        expect(body().props).toMatchObject({ mount, draft: 'Keep this unsent draft', viewport: 387 });
        await action('workspace.tabs.move', { tabId: 'b', targetGroupId: 'group:1' });
        expect(stateOf(screen).groups['group:1'].tabIds).toContain('b');
        expect(body().props).toMatchObject({ mount, draft: 'Keep this unsent draft', viewport: 387 });
    });

    it('refuses an unmeasured split, then moves the selected tab using the measured group extent', async () => {
        const screen = await renderWorkspace(initialState());
        await chooseFromTabMenu(screen, 'b', 'workspace-tab-menu-split-right', () => { expect(production[8].Modal.alertAsync).toHaveBeenCalled(); });
        expect(Object.keys(stateOf(screen).groups)).toHaveLength(1);
        await act(async () => { measureCanvas(screen, 1200, 800); });
        await chooseFromTabMenu(screen, 'b', 'workspace-tab-menu-split-right', () => { expect(Object.keys(stateOf(screen).groups)).toHaveLength(2); });
        const state = stateOf(screen);
        expect(Object.keys(state.groups)).toHaveLength(2);
        expect(state.groups['group:1'].tabIds).toEqual(['a']);
        expect(state.groups[state.focusedGroupId].tabIds).toEqual(['b']);
        expect(screen.root.findAllByType(DestinationInstanceHost).map((node) => [node.props.tabId, node.props.focused, node.props.visible]))
            .toEqual([['a', false, true], ['b', true, true]]);
    });

    it('keeps a split below the two existing minimum widths in one pane', async () => {
        const screen = await renderWorkspace(initialState());
        await act(async () => { measureCanvas(screen, 500, 800); });
        const before = stateOf(screen);
        await chooseFromTabMenu(screen, 'b', 'workspace-tab-menu-split-right', () => { expect(production[8].Modal.alertAsync).toHaveBeenCalled(); });
        expect(Object.keys(stateOf(screen).groups)).toHaveLength(1);
        expect(stateOf(screen)).toBe(before);
    });

    it('splits down using the existing minimum height and collapses the new pane when its tab closes', async () => {
        const screen = await renderWorkspace(initialState());
        await act(async () => { measureCanvas(screen, 800, 800); });
        await chooseFromTabMenu(screen, 'b', 'workspace-tab-menu-split-down', () => { expect(stateOf(screen).root).toMatchObject({ kind: 'split', axis: 'column' }); });
        expect(stateOf(screen).root).toMatchObject({ kind: 'split', axis: 'column' });
        await act(async () => { screen.findByTestId('workspace-tab-close-b')?.props.onPress({}); });
        await settle(() => { expect(stateOf(screen).root).toMatchObject({ kind: 'leaf', id: 'group:1' }); });
        expect(screen.root.findAllByType(DestinationInstanceHost).map((node) => node.props.tabId)).toEqual(['a']);
    });

    it('uses the normal canvas budget while maximized and reveals the focused destination after an admitted split', async () => {
        let initial = reduceWorkspaceState(initialState(), { type: 'openTab', groupId: 'group:1',
            tab: restoredTab('c') });
        initial = reduceWorkspaceState(initial, { type: 'splitTab', tabId: 'c', sourceGroupId: 'group:1',
            targetGroupId: 'group:1', newGroupId: 'group:2', axis: 'row', placement: 'after',
            availableSizePx: 2190, minimumFirstSizePx: 420, minimumSecondSizePx: 420 });
        initial = reduceWorkspaceState(initial, { type: 'toggleMaximize', groupId: 'group:1' });
        const screen = await renderWorkspace(initial);
        expect(screen.root.findAllByType(DestinationInstanceHost).map((node) => node.props.tabId)).toEqual(['b']);

        // The maximized leaf reports the whole canvas; its normal half is too small to split.
        await act(async () => { measureCanvas(screen, 1600, 800); });
        await chooseFromTabMenu(screen, 'b', 'workspace-tab-menu-split-right', () => { expect(production[8].Modal.alertAsync).toHaveBeenCalled(); });
        expect(Object.keys(stateOf(screen).groups)).toHaveLength(2);
        expect(stateOf(screen).maximizedGroupId).toBe('group:1');

        await act(async () => { measureCanvas(screen, 2200, 800); });
        await chooseFromTabMenu(screen, 'b', 'workspace-tab-menu-split-right', () => { expect(Object.keys(stateOf(screen).groups)).toHaveLength(3); });
        expect(Object.keys(stateOf(screen).groups)).toHaveLength(3);
        expect(stateOf(screen).maximizedGroupId).toBeNull();
        expect(screen.root.findAllByType(DestinationInstanceHost).filter((node) => node.props.focused)
            .map((node) => [node.props.tabId, node.props.visible])).toEqual([['b', true]]);
    });
});
