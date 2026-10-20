import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import Color from 'color';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { DocumentTabStrip } from './DocumentTabStrip';
import { createEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropRuntime';

/** The node mock sees React Native's host ScrollView by its mocked host name. */
const isHostScrollView = (type: unknown) => type === 'ScrollView';

installPanelCommonModuleMocks();

function TabPressMenuFixture(props: Readonly<{ runtime: ReturnType<typeof createEntityDragDropRuntime>; variant: 'bar' | 'rail'; sourceOnly?: boolean }>) {
    const [menu, setMenu] = React.useState<string | null>(null);
    const scope = { serverId: 'home', accountId: 'account' };
    const menuLifecycle = {
        onTabMenu: (key: string) => setMenu(key),
        onDismissTabMenu: (key: string) => setMenu(current => current === key ? null : current),
    };
    return <View>
        <DocumentTabStrip {...menuLifecycle} variant={props.variant}
            tabs={[{ key: 'anchor', title: 'Anchor', isPinned: false, isPreview: false }]}
            activeTabKey="anchor" accessibilityLabel="Documents"
            onActivate={() => {}} onPin={() => {}} onUnpin={() => {}} onClose={() => {}}
            renderLeadingIcon={() => null} tabNativeId={id => id} panelNativeId={id => id}
            testIds={{ tab: id => `press-menu-${id}` }}
            entityDragSource={props.sourceOnly ? { runtime: props.runtime, id: 'press-menu', scope,
                getItem: tabId => ({ kind: 'workspace-tab', scope, tabId }) } : undefined}
            entityDragDrop={props.sourceOnly ? undefined : { runtime: props.runtime, id: 'press-menu', scope, acceptedKinds: ['workspace-tab'],
                getItem: tabId => ({ kind: 'workspace-tab', scope, tabId }),
                resolve: () => ({ status: 'refused', reason: { code: 'no-change', message: 'Already here' } }),
                execute: async () => ({ status: 'applied' }),
            }} />
        {menu ? <View testID="open-tab-menu" /> : null}
    </View>;
}

describe('DocumentTabStrip actions', () => {
    it.each([['bar', false], ['rail', false], ['rail', true]] as const)('retires the %s press menu on a real carry (source only: %s) and suppresses that press through drag end', async (variant, sourceOnly) => {
        const runtime = createEntityDragDropRuntime();
        const screen = await renderScreen(<TabPressMenuFixture runtime={runtime} variant={variant} sourceOnly={sourceOnly} />);
        const tab = () => {
            const node = screen.findHostByTestId('press-menu-anchor');
            if (!node) throw new Error('Missing tab press boundary');
            return node;
        };
        await act(async () => { tab().props.onPressIn?.({}); tab().props.onLongPress({}); });
        expect(screen.findAllByTestId('open-tab-menu')).toHaveLength(1);
        const pendingLongPress = tab().props.onLongPress;
        await act(async () => { runtime.begin(JSON.stringify(['document-tab', 'press-menu', 'anchor', 'source']), 'pointer'); });
        expect(runtime.getSnapshot().phase).toBe('carrying');
        expect(screen.findAllByTestId('open-tab-menu')).toHaveLength(0);
        await act(async () => { pendingLongPress({}); });
        expect(screen.findAllByTestId('open-tab-menu')).toHaveLength(0);
        await act(async () => { runtime.cancel(); pendingLongPress({}); });
        expect(screen.findAllByTestId('open-tab-menu')).toHaveLength(0);
        await act(async () => { tab().props.onPressIn?.({}); tab().props.onLongPress({}); });
        expect(screen.findAllByTestId('open-tab-menu')).toHaveLength(1);
        await act(async () => { runtime.begin(JSON.stringify(['document-tab', 'press-menu', 'anchor', 'source']), 'pointer'); });
        expect(screen.findAllByTestId('open-tab-menu')).toHaveLength(0);
        await act(async () => { runtime.cancel(); tab().props.onContextMenu({}); });
        expect(screen.findAllByTestId('open-tab-menu')).toHaveLength(1);
        await screen.unmount();
    });
    it('keeps active strip and raised tabs as ink within the containing material', async () => {
        const { AppShellMaterialFrame } = await import('@/components/navigation/shell/AppShellMaterialFrame');
        const { GlassMaterialSettingsProvider } = await import('@/components/ui/glass/useGlassMaterialSettings');
        const { GlassRuntimeEnvironmentProvider } = await import('@/components/ui/glass/glassRuntimeEnvironment');
        const { glassPresetMaterials } = await import('@/components/ui/glass/glassMaterial');
        const { useUnistyles } = await import('react-native-unistyles');
        const { theme } = useUnistyles();
        for (const reduceTransparency of [false, true]) for (const variant of ['strip', 'bar'] as const) {
            const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ desktopWindow: true, nativeWindowMaterialLive: true, reduceTransparency }}>
                <GlassMaterialSettingsProvider value={{ glassBlurEnabled: true, glassSurfaceMaterials: glassPresetMaterials('everywhere') }}>
                    <AppShellMaterialFrame showChrome={false} dragEnabled={false} leftOffsetPx={0} sidebarWidth={320} titleStrip={null} rail={null} column={null} peek={null}>
                        <DocumentTabStrip variant={variant} tabs={[{ key: 'active', title: 'Active', isPinned: false, isPreview: false }]} activeTabKey="active" accessibilityLabel="Documents"
                            onActivate={() => {}} onPin={() => {}} onUnpin={() => {}} onClose={() => {}} renderLeadingIcon={() => null} tabNativeId={id => id} panelNativeId={id => id}
                            testIds={{ tab: id => `material-tab-${id}` }} />
                    </AppShellMaterialFrame>
                </GlassMaterialSettingsProvider>
            </GlassRuntimeEnvironmentProvider>);
            let node = screen.findHostByTestId('material-tab-active');
            let paint: string | undefined;
            while (node && paint === undefined) {
                const color = StyleSheet.flatten(node.props.style)?.backgroundColor;
                if (typeof color === 'string') paint = color;
                else node = node.parent;
            }
            expect(paint).toBeDefined();
            if (reduceTransparency) expect(Color(paint).hexa()).toBe(Color(variant === 'strip' ? theme.colors.surface.elevated : theme.colors.surface.pressed).hexa());
            else expect(Color(paint).alpha()).toBeLessThan(1);
            await screen.unmount();
        }
    });
    it('offers the same semantic before-tab destination to keyboard and chooser carries', async () => {
        const runtime = createEntityDragDropRuntime();
        const scope = { serverId: 'home', accountId: 'account' };
        runtime.registerSource({ id: 'row', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'destination', scope, href: '/inbox' }) });
        const writes: unknown[] = [];
        const screen = await renderScreen(<DocumentTabStrip
            variant="bar" tabs={[{ key: 'anchor', title: 'Anchor', isPinned: false, isPreview: false }]}
            activeTabKey="anchor" accessibilityLabel="Documents"
            onActivate={() => {}} onPin={() => {}} onUnpin={() => {}} onClose={() => {}}
            renderLeadingIcon={() => null} tabNativeId={id => id} panelNativeId={id => id}
            entityDragDrop={{
                runtime, id: 'strip', scope, acceptedKinds: ['destination', 'workspace-tab'],
                getItem: tabId => ({ kind: 'workspace-tab', scope, tabId }),
                resolve: ({ beforeTabId }) => ({ status: 'allowed', effect: {
                    actionId: 'workspace.tabs.open', input: { href: '/inbox', beforeTabId },
                    preview: { verb: 'Open', target: 'Anchor' },
                } }),
                execute: async effect => { writes.push(effect.input); return { status: 'applied' }; },
            }}
        />);
        const destinations = runtime.getDestinations('row');
        expect(destinations).toHaveLength(1);
        await act(async () => { await runtime.perform('row', destinations[0].targetId, destinations[0].destination); });
        expect(writes).toEqual([{ href: '/inbox', beforeTabId: 'anchor' }]);
        await screen.unmount();
        expect(runtime.getDestinations('row')).toEqual([]);
    });
    it('marks the gap before an admitting tab, and lights nothing where the strip refuses', async () => {
        const runtime = createEntityDragDropRuntime();
        const scope = { serverId: 'home', accountId: 'account' };
        runtime.registerSource({ id: 'row', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'destination', scope, href: '/inbox' }) });
        const screen = await renderScreen(<DocumentTabStrip
            variant="bar" tabs={[
                { key: 'open', title: 'Open', isPinned: false, isPreview: false },
                { key: 'full', title: 'Full', isPinned: false, isPreview: false },
            ]}
            activeTabKey="open" accessibilityLabel="Documents"
            onActivate={() => {}} onPin={() => {}} onUnpin={() => {}} onClose={() => {}}
            renderLeadingIcon={() => null} tabNativeId={id => id} panelNativeId={id => id}
            entityDragDrop={{
                runtime, id: 'strip', scope, acceptedKinds: ['destination'],
                getItem: () => null,
                resolve: ({ beforeTabId }) => beforeTabId === 'open'
                    ? { status: 'allowed', effect: { actionId: 'workspace.tabs.open', input: { beforeTabId }, preview: { verb: 'Open', target: 'Open' } } }
                    : { status: 'refused', reason: { code: 'no', message: 'No' } },
                execute: async () => ({ status: 'applied' }),
            }}
        />);
        const targetFor = (key: string) => runtime.getDestinations('row').find(entry => entry.label === (key === 'open' ? 'Open' : 'Full'))!;
        const carry = runtime.begin('row', 'keyboard');
        act(() => carry?.choose(targetFor('open').targetId, targetFor('open').destination));
        expect(screen.findHostByTestId('document-tab-drop-before-open')).toBeTruthy();
        act(() => carry?.choose(targetFor('full').targetId, targetFor('full').destination));
        expect(screen.findHostByTestId('document-tab-drop-before-open')).toBeFalsy();
        expect(screen.findHostByTestId('document-tab-drop-before-full')).toBeFalsy();
        act(() => carry?.cancel());
        await screen.unmount();
    });
    it.each(['bar', 'strip'] as const)('keeps pinned needs-you status visible and named in the %s presentation', async (variant) => {
        const screen = await renderScreen(<DocumentTabStrip
            variant={variant}
            tabs={[{ key: 'session', title: 'Fix layout', isPinned: true, isPreview: false }]}
            activeTabKey="session" accessibilityLabel="Workspace"
            onActivate={() => {}} onPin={() => {}} onUnpin={() => {}} onClose={() => {}}
            renderLeadingIcon={() => null} tabNativeId={(id) => `tab-${id}`} panelNativeId={(id) => `panel-${id}`}
            resolveTabPresentation={() => ({ status: { tone: 'attention', label: 'Needs you' } })}
            testIds={{ tab: (id) => `tab-${id}`, tabStatus: (id) => `status-${id}` }}
        />);
        expect(screen.findHostByTestId('status-session')).toBeTruthy();
        expect(screen.findByTestId('tab-session')?.props.accessibilityLabel).toContain('Needs you');
    });

    it('keeps the Agent mark beside a background working spinner and the active close action', async () => {
        const screen = await renderScreen(<DocumentTabStrip
            variant="bar"
            tabs={[{ key: 'active', title: 'Open session', isPinned: false, isPreview: false }, { key: 'background', title: 'Working session', isPinned: false, isPreview: false }]}
            activeTabKey="active" accessibilityLabel="Workspace"
            onActivate={() => {}} onPin={() => {}} onUnpin={() => {}} onClose={() => {}}
            renderLeadingIcon={(tab) => <View testID={`agent-${tab.key}`} />}
            tabNativeId={(id) => `tab-${id}`} panelNativeId={(id) => `panel-${id}`}
            resolveTabPresentation={() => ({ status: { tone: 'working', label: 'Working' } })}
            testIds={{ tab: (id) => `tab-${id}`, tabSpinner: (id) => `spinner-${id}`, tabClose: (id) => `close-${id}` }}
        />);
        expect(screen.findHostByTestId('spinner-background')).toBeTruthy();
        expect(screen.findHostByTestId('spinner-active')).toBeFalsy();
        expect(screen.findByTestId('close-active')).toBeTruthy();
        expect(screen.findHostByTestId('agent-background')).toBeTruthy();
    });

    it('identifies each tab in its action names and preserves pin, unpin and unsaved close intent', async () => {
        const pin = vi.fn();
        const unpin = vi.fn();
        const close = vi.fn();
        const screen = await renderScreen(<DocumentTabStrip
            tabs={[
                { key: 'a', title: 'Alpha', isPinned: false, isPreview: true },
                { key: 'b', title: 'Beta', isPinned: true, isPreview: false },
            ]}
            activeTabKey="a" accessibilityLabel="Documents"
            onActivate={() => {}} onPin={pin} onUnpin={unpin} onClose={close}
            renderLeadingIcon={() => null} tabNativeId={(id) => `tab-${id}`} panelNativeId={(id) => `panel-${id}`}
            unsavedTabKeys={new Set(['b'])}
            testIds={{ tabPin: (id) => `pin-${id}`, tabUnpin: (id) => `unpin-${id}`, tabClose: (id) => `close-${id}` }}
        />);
        const pinButton = screen.findByTestId('pin-a');
        const unpinButton = screen.findByTestId('unpin-b');
        const closeButton = screen.findByTestId('close-b');
        expect(pinButton?.props.accessibilityLabel).toContain('Alpha');
        expect(unpinButton?.props.accessibilityLabel).toContain('Beta');
        expect(closeButton?.props.accessibilityLabel).toContain('Beta');
        expect(closeButton?.props.accessibilityLabel).toContain('closeUnsavedTabA11y');
        await act(async () => {
            pinButton?.props.onPress({ stopPropagation() {} });
            unpinButton?.props.onPress({ stopPropagation() {} });
            closeButton?.props.onPress({ stopPropagation() {} });
        });
        expect(pin).toHaveBeenCalledWith('a');
        expect(unpin).toHaveBeenCalledWith('b');
        expect(close).toHaveBeenCalledWith('b');
    });

    it('keeps pinned tabs fixed ahead of one scrolling strip of every other tab and scrolls the open tab into view', async () => {
        const keys = ['pin', 'a', 'b', 'c', 'd', 'e', 'f'];
        const scrollTo = vi.fn();
        const strip = (active: string) => <DocumentTabStrip variant="bar"
            tabs={keys.map(key => ({ key, title: `Tab ${key}`, isPinned: key === 'pin', isPreview: false }))}
            activeTabKey={active} accessibilityLabel="Documents"
            onActivate={() => {}} onPin={() => {}} onUnpin={() => {}} onClose={() => {}}
            renderLeadingIcon={() => null} tabNativeId={id => id} panelNativeId={id => id}
            testIds={{ tab: id => `tab-${id}` }} />;
        const screen = await renderScreen(strip('a'), {
            createNodeMock: element => (isHostScrollView(element.type) ? { scrollTo } : null),
        });
        const scroller = screen.root.findAll(node => isHostScrollView(node.type));
        expect(scroller).toHaveLength(1);
        const inScroller = (key: string) => scroller[0]!.findAll(node => node.props?.testID === `tab-${key}`).length > 0;
        // Every unpinned tab stays in the strip (nothing is truncated behind a count); the pinned one leads outside it.
        expect(keys.filter(inScroller)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
        expect(screen.findAllByTestId('tab-pin').length).toBeGreaterThan(0);
        // Measured: a 300 px viewport over six 120 px tabs.
        await act(async () => {
            scroller[0]!.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 30 } } });
            for (const [index, key] of keys.slice(1).entries()) {
                screen.findByTestId(`document-tab-frame-${key}`)?.props.onLayout?.({ nativeEvent: { layout: { x: index * 122, y: 0, width: 120, height: 30 } } });
            }
        });
        scrollTo.mockClear();
        await screen.update(strip('f'));
        expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ x: 5 * 122 + 120 - 300 + 12 }));
    });

    it('takes a carried item only at a tab inside the visible strip, never at one scrolled out of view', async () => {
        const runtime = createEntityDragDropRuntime();
        const scope = { serverId: 'home', accountId: 'account' };
        runtime.registerSource({ id: 'row', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'destination', scope, href: '/inbox' }) });
        // Window geometry is the platform's: the strip shows 0–100; tab b lies at 200–260, past its clip.
        const rects: Record<string, { x: number; y: number; width: number; height: number }> = {
            'document-tab-viewport': { x: 0, y: 0, width: 100, height: 30 },
            'document-tab-entity-a': { x: 0, y: 0, width: 60, height: 30 },
            'document-tab-entity-b': { x: 200, y: 0, width: 60, height: 30 },
        };
        const screen = await renderScreen(<DocumentTabStrip variant="bar"
            tabs={['a', 'b'].map(key => ({ key, title: key, isPinned: false, isPreview: false }))}
            activeTabKey="a" accessibilityLabel="Documents"
            onActivate={() => {}} onPin={() => {}} onUnpin={() => {}} onClose={() => {}}
            renderLeadingIcon={() => null} tabNativeId={id => id} panelNativeId={id => id}
            testIds={{ tab: id => `tab-${id}` }}
            entityDragDrop={{ runtime, id: 'strip', scope, acceptedKinds: ['destination'], getItem: () => null,
                resolve: ({ beforeTabId }) => ({ status: 'allowed', effect: { actionId: 'workspace.tabs.open',
                    input: { href: '/inbox', beforeTabId }, preview: { verb: 'Open', target: String(beforeTabId) } } }),
                execute: async () => ({ status: 'applied' }) }} />, {
            createNodeMock: element => {
                const rect = rects[String(element.props?.testID ?? '')];
                return rect ? { getBoundingClientRect: () => rect } : null;
            },
        });
        const carry = runtime.begin('row', 'pointer');
        await act(async () => { carry?.move({ x: 230, y: 10 }); });
        expect(runtime.getSnapshot().targetId).toBeNull();
        await act(async () => { carry?.move({ x: 30, y: 10 }); });
        expect(runtime.getSnapshot().targetId).not.toBeNull();
        act(() => carry?.cancel());
        await screen.unmount();
    });

    it('shows a tab\'s live status in its trailing slot and keeps close on the open tab without one (terminal lab B1)', async () => {
        const screen = await renderScreen(<DocumentTabStrip
            variant="bar"
            tabs={[
                { key: 'zsh', title: 'zsh', isPinned: false, isPreview: false },
                { key: 'vite', title: 'vite', isPinned: false, isPreview: false },
                { key: 'claude', title: 'Claude', isPinned: false, isPreview: false },
            ]}
            activeTabKey="zsh" accessibilityLabel="Terminals"
            onActivate={() => {}} onPin={() => {}} onUnpin={() => {}} onClose={() => {}}
            renderLeadingIcon={() => null} tabNativeId={(id) => `tab-${id}`} panelNativeId={(id) => `panel-${id}`}
            resolveTabPresentation={(tab) => tab.key === 'vite' ? { status: { tone: 'running', label: 'Running' } }
                : tab.key === 'claude' ? { status: { tone: 'attention', label: 'Needs you' } } : null}
            testIds={{ tab: (id) => `tab-${id}`, tabClose: (id) => `close-${id}`, tabStatus: (id) => `status-${id}` }}
        />);
        expect(screen.findByTestId('close-zsh')).toBeTruthy();
        expect(screen.findByTestId('status-zsh')).toBeFalsy();
        expect(screen.findByTestId('status-vite')).toBeTruthy();
        expect(screen.findByTestId('close-vite')).toBeFalsy();
        expect(screen.findByTestId('tab-claude')?.props.accessibilityLabel).toContain('Needs you');
    });
});
