import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import * as React from 'react';
import { StyleSheet } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// The static storage graph reaches the Socket.IO transport; register its external boundary before any import.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { createSessionListRenderableSessionFixture, flushHookEffects, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { AppShellPluginUiProjectionValueProvider } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { PluginAppPageLaunchInputScope } from '@/components/appShell/plugins/pluginAppPageNavigation';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel, type PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import type { PluginAppPage } from '@/components/appShell/plugins/pluginAppPages';
import { UniversalSearchRuntimeProvider } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { resolveSessionListDensityViewState } from '@/components/sessions/shell/resolveSessionListDensityViewState';
import { NavigationSurfacePlacementsV1Schema, type NavigationSurfacePlacementsV1 } from '@/sync/domains/settings/mobileSurfacePinning';

const routeState = vi.hoisted(() => ({ push: vi.fn(), pathname: '/' }));
const openUniversalSearch = vi.hoisted(() => vi.fn());
const surfaceState = vi.hoisted(() => ({
    platformOS: 'web' as 'web' | 'ios' | 'android',
    isTablet: false,
    windowWidth: 390,
}));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        pathname: () => routeState.pathname,
        router: { push: (href: unknown) => routeState.push(href) },
    }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const dimensions = () => ({ width: surfaceState.isTablet ? 840 : surfaceState.windowWidth, height: 900, scale: 1, fontScale: 1 });
    return createReactNativeWebMock({
        Platform: {
            get OS() { return surfaceState.platformOS; },
            get isPad() { return surfaceState.isTablet; },
            select: <T,>(choices: { web?: T; default?: T; native?: T; ios?: T; android?: T }) => (
                surfaceState.platformOS === 'web' ? choices.web ?? choices.default
                    : choices[surfaceState.platformOS] ?? choices.native ?? choices.default
            ),
        },
        useWindowDimensions: dimensions,
        Dimensions: { get: dimensions },
    });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
const runtime = installSessionPaneRuntimeTestHarness({ scopeId: 'app' });
let projection: PluginUiProjectionModel;

function placement(localId: string, container: 'appPage' | 'rightSidebarTab',
    extra: Partial<Pick<PluginAppPage, 'requestedPlacement' | 'disabledReason'>> = {}): PluginUiSurfacePlacementProjection {
    const pluginId = container === 'rightSidebarTab' ? 'acme.review' : `acme.${localId}`;
    const binding = normalizePluginUiDestinationBindingV1({
        pluginId, destinationId: localId, rendererId: localId, container, target: { kind: 'app' },
    });
    if (!binding) throw new Error('invalid destination fixture');
    return {
        id: `surfacePlacement:${pluginId}:${localId}`, pluginId, occurrenceId: `${pluginId}-occurrence`,
        contributionKind: 'surfacePlacement', descriptorId: localId, binding, target: { kind: 'app' },
        renderer: { kind: 'host', rendererId: localId },
        display: { developerFallback: localId, ...(extra.requestedPlacement ? { placement: extra.requestedPlacement } : {}) },
        availability: extra.disabledReason
            ? { state: 'disabled', reason: extra.disabledReason, diagnostics: [] }
            : { state: 'available', reason: 'available', diagnostics: [] },
        headerActions: [],
        ...(container === 'rightSidebarTab' ? { rightSidebar: { tabId: localId, scopes: ['app'] } } : {}),
    };
}
function page(localId: string, extra: Partial<Pick<PluginAppPage, 'requestedPlacement' | 'disabledReason'>> = {}) {
    return placement(localId, 'appPage', extra);
}
const reviewTab = placement('review-panel', 'rightSidebarTab');

function setCatalog(input: Readonly<{
    pages?: readonly PluginUiSurfacePlacementProjection[];
    externalSessions?: boolean;
    tabs?: readonly PluginUiSurfacePlacementProjection[];
    navigationPlacements?: NavigationSurfacePlacementsV1;
}>) {
    const placements = [...(input.pages ?? []), ...(input.tabs ?? [])];
    projection = { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 1,
        surfacePlacementsById: Object.fromEntries(placements.map(entry => [entry.id, entry])) };
    storage.setState({
        settings: { ...storage.getState().settings, sessionListDensity: 'narrow',
            featureToggles: { ...storage.getState().settings.featureToggles, 'sessions.direct': input.externalSessions ?? true } },
        localSettings: { ...storage.getState().localSettings,
            navigationSurfacePlacementsV1: NavigationSurfacePlacementsV1Schema.parse(input.navigationPlacements ?? {}) },
    });
}
function Wrapper({ children }: React.PropsWithChildren) {
    return <runtime.Wrapper><AppShellPluginUiProjectionValueProvider value={{
        pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current',
        interactionEnabled: true, machineId: null, serverId: runtime.serverId, platform: surfaceState.platformOS,
        accountLifetime: captureActiveServerAccountScopeLifetime(), clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {},
        reloadConnectedAccountProjection: () => {},
    }}><PluginAppPageLaunchInputScope pluginUiProjection={projection}>
        <UniversalSearchRuntimeProvider value={{ open: openUniversalSearch, buildCommands: () => [] }}>
            {children}
        </UniversalSearchRuntimeProvider>
    </PluginAppPageLaunchInputScope></AppShellPluginUiProjectionValueProvider></runtime.Wrapper>;
}
async function render(element: React.ReactElement) {
    const screen = await renderScreen(element, { wrapper: Wrapper });
    await flushHookEffects();
    return screen;
}
const rowIds = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen
    .findAllByType(Item).map(node => String(node.props.testID));
function rowFor(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) {
    return screen.findAllByType(Item).find(node => node.props.testID === testID);
}
async function renderActionRowStyle() {
    const { ColumnDestinationRows } = await import('./ColumnDestinationRows');
    const screen = await render(<ColumnDestinationRows column="sessions" />);
    const row = rowFor(screen, 'compact-app-destination:plugin:acme.notes:notes');
    if (!row) throw new Error('Expected the notes destination row');
    const style = StyleSheet.flatten(row.props.style);
    if (!style) throw new Error('Expected the notes destination row-size style');
    return style;
}

describe('ColumnDestinationRows', () => {
    beforeEach(() => {
        routeState.push.mockReset();
        routeState.pathname = '/';
        surfaceState.windowWidth = 390;
        openUniversalSearch.mockReset();
        surfaceState.platformOS = 'web';
        surfaceState.isTablet = false;
        setCatalog({ pages: [page('notes', { requestedPlacement: { kind: 'column', column: 'sessions' } })] });
    });

    it('lists only the entries placed in its column, selected while their page is open', async () => {
        routeState.pathname = '/plugins/acme.log/log/today';
        setCatalog({
            pages: [
                page('log', { requestedPlacement: { kind: 'column', column: 'sessions' } }),
                page('board'),
                page('later', { requestedPlacement: { kind: 'column', column: 'workflows' } }),
            ],
        });
        const { ColumnDestinationRows } = await import('./ColumnDestinationRows');

        const sessions = await render(<ColumnDestinationRows column="sessions" />);
        expect(rowIds(sessions)).toEqual(['external-sessions-browse-button', 'compact-app-destination:plugin:acme.log:log']);
        expect(rowFor(sessions, 'compact-app-destination:plugin:acme.log:log')?.props.selected).toBe(true);
        expect(rowFor(sessions, 'external-sessions-browse-button')?.props.selected).toBe(false);
        // Destinations are not sessions: quiet navigation rows on the column's surface, never a sheet.
        expect(sessions.findByType(ItemGroup).props.surface).toBe('none');

        // A column with nothing placed in it draws no rows at all.
        const plugins = await render(<ColumnDestinationRows column="plugins" />);
        expect(rowIds(plugins)).toEqual([]);
    });

    it("pins the app's own destinations on the phone launcher and keeps plugin destinations behind More", async () => {
        setCatalog({
            pages: [page('log', { requestedPlacement: { kind: 'column', column: 'sessions' } }), page('board')],
            tabs: [reviewTab],
        });
        const { ColumnDestinationRows } = await import('./ColumnDestinationRows');
        const launcher = await render(<ColumnDestinationRows />);
        // Four pinned rows keep "My work" in the first third of a phone screen (lab xrail P1).
        const pinned = [
            'sessions-search-all-button',
            'compact-app-destination:workflows',
            'compact-app-destination:artifacts',
            'compact-app-destination:bots',
        ];
        expect(rowIds(launcher)).toEqual([...pinned, 'phone-launcher-more']);

        // More opens in place: the rest of the destinations, then the way to change what is pinned.
        await pressTestInstanceAsync(rowFor(launcher, 'phone-launcher-more'));
        expect(rowIds(launcher)).toEqual([
            ...pinned,
            'phone-launcher-more',
            'compact-app-destination:boards',
            'external-sessions-browse-button',
            'compact-app-destination:plugin:acme.log:log',
            'compact-app-destination:plugins',
            'compact-app-destination:plugin:acme.board:board',
            'compact-app-destination:rightSidebarTab:plugin:acme.review:review-panel',
            'phone-launcher-customize',
        ]);
    });

    it("honours the launcher's own placements, never the desktop rail's", async () => {
        setCatalog({
            pages: [page('board')],
            navigationPlacements: {
                phoneLauncher: { orderedIds: [], placements: { 'plugin:acme.board:board': 'pinned', boards: 'hidden', artifacts: 'overflow' } },
                appRail: { orderedIds: [], placements: { workflows: 'hidden' } },
            },
        });
        const { ColumnDestinationRows } = await import('./ColumnDestinationRows');
        const launcher = await render(<ColumnDestinationRows />);
        const ids = rowIds(launcher);
        expect(ids).toContain('compact-app-destination:plugin:acme.board:board');
        expect(ids).toContain('compact-app-destination:workflows');
        expect(ids).not.toContain('compact-app-destination:boards');
        expect(ids).not.toContain('compact-app-destination:artifacts');
        await pressTestInstanceAsync(rowFor(launcher, 'phone-launcher-more'));
        expect(rowIds(launcher)).toContain('compact-app-destination:artifacts');
        expect(rowIds(launcher)).not.toContain('compact-app-destination:boards');
    });

    it('names why a pinned destination is unavailable, and dims an unavailable one in More without repeating it', async () => {
        setCatalog({
            pages: [page('pinned', { disabledReason: 'feature_disabled' }), page('later', { disabledReason: 'feature_disabled' })],
            navigationPlacements: { phoneLauncher: { orderedIds: [], placements: { 'plugin:acme.pinned:pinned': 'pinned' } } },
        });
        const { ColumnDestinationRows } = await import('./ColumnDestinationRows');
        const launcher = await render(<ColumnDestinationRows />);
        expect(rowFor(launcher, 'compact-app-destination:plugin:acme.pinned:pinned')?.props.subtitle).toEqual(expect.any(String));
        await pressTestInstanceAsync(rowFor(launcher, 'phone-launcher-more'));
        const later = rowFor(launcher, 'compact-app-destination:plugin:acme.later:later');
        expect(later?.props.disabled).toBe(true);
        expect(later?.props.subtitle).toBeUndefined();
    });

    it('opens Search over the page with the column scope, and navigates every other row through the one activation', async () => {
        const { ColumnDestinationRows } = await import('./ColumnDestinationRows');
        const scope = { accountId: 'account-b', serverId: 'home-b', sessionId: null, machineId: null, rootPath: null } as const;
        const screen = await render(<ColumnDestinationRows universalSearchScope={scope} />);

        await pressTestInstanceAsync(rowFor(screen, 'sessions-search-all-button'));
        expect(openUniversalSearch).toHaveBeenCalledWith(undefined, scope);
        expect(routeState.push).not.toHaveBeenCalled();

        await pressTestInstanceAsync(rowFor(screen, 'phone-launcher-more'));
        await pressTestInstanceAsync(rowFor(screen, 'compact-app-destination:plugins'));
        await pressTestInstanceAsync(rowFor(screen, 'compact-app-destination:plugin:acme.notes:notes'));
        expect(routeState.push.mock.calls.map(([href]) => href)).toEqual(['/plugins', '/plugins/acme.notes/notes']);
    });

    it.each([
        { platformOS: 'ios' as const, isTablet: true },
        { platformOS: 'ios' as const, isTablet: false },
        { platformOS: 'android' as const, isTablet: true },
    ])('holds the native touch floor on $platformOS (tablet: $isTablet)', async (surface) => {
        surfaceState.platformOS = surface.platformOS;
        surfaceState.isTablet = surface.isTablet;
        const minimumTargetSize = resolveMinimumInteractiveTargetSize(surface.platformOS);
        const densityHeight = resolveSessionListDensityViewState('narrow', {
            isTablet: surface.isTablet,
            platform: surface.platformOS,
        }).rowHeight;
        const style = await renderActionRowStyle();

        expect(style.height).toBe(Math.max(densityHeight, minimumTargetSize));
        expect(style.minHeight).toBe(Math.max(densityHeight, minimumTargetSize));
    });

    it('keeps the desktop-web row on the session-list density grid', async () => {
        surfaceState.platformOS = 'web';
        surfaceState.isTablet = false;
        surfaceState.windowWidth = 800;
        const densityHeight = resolveSessionListDensityViewState('narrow', {
            isTablet: false,
            platform: 'web',
            windowWidth: 800,
        }).rowHeight;
        // A precise pointer only owes the WCAG pointer floor, which the density grid already clears;
        // the touch floor must not lift the desktop row.
        const pointerFloor = resolveMinimumInteractiveTargetSize('web');
        expect(densityHeight).toBeGreaterThanOrEqual(pointerFloor);
        expect(densityHeight).toBeLessThan(resolveMinimumInteractiveTargetSize('ios'));

        const style = await renderActionRowStyle();

        expect(style.height).toBe(densityHeight);
        expect(style.minHeight).toBe(densityHeight);
    });

    it('shows a localized unavailable reason instead of a silent disabled row', async () => {
        setCatalog({ pages: [page('notes', { requestedPlacement: { kind: 'column', column: 'sessions' }, disabledReason: 'feature_disabled' })] });
        const { ColumnDestinationRows } = await import('./ColumnDestinationRows');
        const screen = await render(<ColumnDestinationRows column="sessions" />);
        const row = rowFor(screen, 'compact-app-destination:plugin:acme.notes:notes');

        expect(row?.props.disabled).toBe(true);
        expect(row?.props.subtitle).toEqual(expect.any(String));
        expect(row?.props.subtitle).not.toBe('feature_disabled');
    });

    it("carries the Bots faces and what needs you on the phone launcher's one Bots entry", async () => {
        // DF-B1: the launcher row is the phone's only way to the roster, so it says what the lab's
        // My work entry said (b-rail Ap): a few faces, then what needs you.
        const bots = ['alpha', 'beta'].map((id) => createSessionListRenderableSessionFixture({
            id, metadata: { path: '/home/happier', bot: { kind: 'bot' } },
        }));
        storage.setState({ sessionListRowsByServerId: {
            ...storage.getState().sessionListRowsByServerId,
            [runtime.serverId]: Object.fromEntries(bots.map((row) => [row.id, row])),
        } });
        const { ColumnDestinationRows } = await import('./ColumnDestinationRows');
        const launcher = await render(<ColumnDestinationRows />);

        const row = rowFor(launcher, 'compact-app-destination:bots');
        expect(row?.props.rightElement).toBeTruthy();
        // Still a navigation row: the faces sit before the same chevron every launcher row has.
        expect(row?.props.keepChevronWithRightElement).toBe(true);
        expect(launcher.findAllByTestId('bots-entry-summary')).toHaveLength(1);
        // A column (desktop) keeps its quiet row: the rail button carries the Bots dot there.
        const column = await render(<ColumnDestinationRows column="sessions" />);
        expect(column.findAllByTestId('bots-entry-summary')).toHaveLength(0);
    });

    it('keeps column and phone discovery visible when the rail icon is hidden', async () => {
        setCatalog({
            pages: [page('notes', { requestedPlacement: { kind: 'column', column: 'sessions' } })],
            navigationPlacements: { appRail: { orderedIds: ['plugin:acme.notes:notes'], placements: { 'plugin:acme.notes:notes': 'hidden' } } },
        });
        const { ColumnDestinationRows } = await import('./ColumnDestinationRows');
        const screen = await render(<ColumnDestinationRows column="sessions" />);

        expect(screen.findByTestId('compact-app-destination:plugin:acme.notes:notes')).not.toBeNull();
        expect(rowIds(screen)[0]).toBe('external-sessions-browse-button');
        const launcher = await render(<ColumnDestinationRows />);
        await pressTestInstanceAsync(rowFor(launcher, 'phone-launcher-more'));
        expect(launcher.findByTestId('compact-app-destination:plugin:acme.notes:notes')).not.toBeNull();
    });
});
