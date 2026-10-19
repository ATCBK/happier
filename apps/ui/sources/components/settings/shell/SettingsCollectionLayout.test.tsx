import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const windowState = vi.hoisted(() => ({ fontScale: 1, width: 1200, height: 800 }));

installSettingsViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            useWindowDimensions: () => ({ width: windowState.width, height: windowState.height, scale: 1, fontScale: windowState.fontScale }),
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ pathname: '/settings/machines/machine-1' }).module;
    },
});

const { SettingsCollectionLayout } = await import('./SettingsCollectionLayout');
const { SettingsFloatingControlsHost } = await import('./SettingsModalFloatingControls');
const { PageHeader } = await import('@/components/ui/layout/PageHeader');
const { useHappierCollectionLayout } = await import('@happier-dev/plugin-ui/presentation');
const { HAPPIER_COLLECTION_RAIL_WIDTH_PX } = await import('@happier-dev/plugin-ui/advanced');

const modeSeen: Array<string | null> = [];
const detailMounts = { count: 0 };

function DetailProbe() {
    const mode = useHappierCollectionLayout()?.mode ?? null;
    modeSeen.push(mode);
    React.useEffect(() => {
        detailMounts.count += 1;
    }, []);
    return React.createElement('DetailProbe', { mode });
}

async function renderCollection() {
    return renderScreen(
        <SettingsCollectionLayout
            navigator="machines"
            rootPathname="/settings/machines"
            resolveChildRoute={() => '[id]'}
            rail={<View testID="machines-rail" />}
            railWidth="standard"
            detailMinWidthPx={480}
            testID="settings-machines"
            detailTop={<DetailProbe />}
        />,
    );
}

function hostByTestID(screen: Awaited<ReturnType<typeof renderCollection>>, testID: string): ReactTestInstance | null {
    return screen.root.findAll((node) => typeof node.type === 'string' && node.props.testID === testID)[0] ?? null;
}

async function layoutAt(screen: Awaited<ReturnType<typeof renderCollection>>, width: number) {
    const container = hostByTestID(screen, 'settings-machines-layout');
    if (!container) throw new Error('Missing collection layout');
    await act(async () => {
        (container.props.onLayout as (event: unknown) => void)({ nativeEvent: { layout: { width, height: 800, x: 0, y: 0 } } });
    });
}

function currentMode(screen: Awaited<ReturnType<typeof renderCollection>>): unknown {
    return screen.root.findAllByType('DetailProbe' as never)[0]?.props.mode;
}

describe('SettingsCollectionLayout', () => {
    beforeEach(() => {
        windowState.fontScale = 1;
        windowState.width = 1200;
        windowState.height = 800;
    });

    /** The options the collection gives the one phone header above both panes. */
    function outerHeaderOptions(screen: Awaited<ReturnType<typeof renderScreen>>): Record<string, unknown> | undefined {
        return screen.root.findAll((node) => node.type === ('StackScreen' as never) && node.props.options !== undefined)[0]
            ?.props.options as Record<string, unknown> | undefined;
    }

    it('leaves the phone header untitled on an entity page that names itself, and titles every other page', async () => {
        windowState.width = 390;
        windowState.height = 844;
        const renderAt = (childRoute: string) => renderScreen(
            <SettingsCollectionLayout
                navigator="teams"
                rootPathname="/settings/teams"
                resolveChildRoute={() => childRoute}
                rail={<View testID="teams-rail" />}
                railWidth="standard"
                detailMinWidthPx={480}
                testID="settings-teams"
            />,
        );

        // A member, a Group and a Team head their own page with their name.
        for (const entityRoute of [
            '[serverId]/[teamId]/members/[membershipId]',
            '[serverId]/[teamId]/groups/[groupId]',
            '[serverId]/[teamId]/index',
        ]) {
            const screen = await renderAt(entityRoute);
            expect(outerHeaderOptions(screen)?.headerTitle).toBe('');
            act(() => screen.tree.unmount());
        }

        // A collection page keeps its title in the phone header.
        const members = await renderAt('[serverId]/[teamId]/members/index');
        expect(outerHeaderOptions(members)?.headerTitle).toBe('teams.tabs.members');
    });

    it('puts the rail beside the detail when both fit, and shows the detail stack alone when they do not, keeping the detail mounted', async () => {
        detailMounts.count = 0;
        const screen = await renderCollection();

        // Before the first layout nothing claims the rail.
        expect(hostByTestID(screen, 'machines-rail')).toBeNull();

        await layoutAt(screen, 1200);
        expect(hostByTestID(screen, 'machines-rail')).not.toBeNull();
        expect(currentMode(screen)).toBe('split');

        await layoutAt(screen, 390);
        // Narrow: the detail stack's index page is the list, so the rail is gone ...
        expect(hostByTestID(screen, 'machines-rail')).toBeNull();
        expect(currentMode(screen)).toBe('stacked');
        // ... and the open detail kept its state across the change.
        expect(detailMounts.count).toBe(1);
    });

    it('keeps shared detail content mounted while measuring and across width changes', async () => {
        detailMounts.count = 0;
        const screen = await renderScreen(
            <SettingsCollectionLayout navigator="machines" rootPathname="/settings/machines"
                resolveChildRoute={() => '[id]'} rail={<View testID="machines-rail" />}
                railWidth="standard" detailMinWidthPx={480} testID="settings-machines"
                detailTop={<DetailProbe />}
            />,
        );
        expect(currentMode(screen)).toBe('measuring');
        await layoutAt(screen, 1200);
        expect(currentMode(screen)).toBe('split');
        await layoutAt(screen, 390);
        expect(currentMode(screen)).toBe('stacked');
        expect(detailMounts.count).toBe(1);
    });

    it('needs room for the rail and the detail minimum at the current text scale before splitting', async () => {
        const screen = await renderCollection();
        // 272 + 480 = 752: one pixel short stays stacked, the exact width splits.
        await layoutAt(screen, 751);
        expect(hostByTestID(screen, 'machines-rail')).toBeNull();
        await layoutAt(screen, 752);
        expect(hostByTestID(screen, 'machines-rail')).not.toBeNull();
    });

    it('reads the rail width from its role: standard and detailed each need their own rail plus the detail minimum', async () => {
        const renderRole = (railWidth: 'standard' | 'detailed') => renderScreen(
            <SettingsCollectionLayout navigator="machines" rootPathname="/settings/machines"
                resolveChildRoute={() => '[id]'} rail={<View testID="machines-rail" />}
                railWidth={railWidth} detailMinWidthPx={480} testID="settings-machines" />,
        );
        for (const role of ['standard', 'detailed'] as const) {
            const screen = await renderRole(role);
            const needed = HAPPIER_COLLECTION_RAIL_WIDTH_PX[role] + 480;
            await layoutAt(screen, needed - 1);
            expect(hostByTestID(screen, 'machines-rail'), `${role} one pixel short`).toBeNull();
            await layoutAt(screen, needed);
            expect(hostByTestID(screen, 'machines-rail'), `${role} exact fit`).not.toBeNull();
        }
    });

    it('gives the whole width to a page shown without its rail (a collection index that is itself the list)', async () => {
        const screen = await renderScreen(
            <SettingsCollectionLayout
                navigator="machines"
                rootPathname="/settings/machines"
                resolveChildRoute={() => 'index'}
                rail={null}
                railWidth="standard"
                detailMinWidthPx={480}
                testID="settings-machines"
                detailTop={<DetailProbe />}
            />,
        );
        // Wide enough for the detail alone but not for rail + detail: no rail column is reserved.
        await layoutAt(screen, 600);
        const listPane = hostByTestID(screen, 'settings-machines-list-pane');
        const flattened = [listPane?.props.style].flat(Infinity).filter(Boolean)
            .reduce((merged: Record<string, unknown>, part: Record<string, unknown>) => ({ ...merged, ...part }), {});
        expect(currentMode(screen)).toBe('split');
        expect(flattened.flex).toBe(0);
        expect(flattened.borderRightWidth ?? 0).toBe(0);
    });

    it('scales the rail and detail minimums with larger text', async () => {
        windowState.fontScale = 1.5;
        const screen = await renderCollection();
        await layoutAt(screen, 1127);
        expect(hostByTestID(screen, 'machines-rail')).toBeNull();
        await layoutAt(screen, 1128);
        expect(hostByTestID(screen, 'machines-rail')).not.toBeNull();
    });

    it('keeps the collection header free of a back control: the collection is the page, its list sits beside the detail', async () => {
        const screen = await renderScreen(
            <SettingsFloatingControlsHost enabled>
                <SettingsCollectionLayout
                    navigator="machines"
                    rootPathname="/settings/machines"
                    resolveChildRoute={() => '[id]'}
                    rail={<View testID="machines-rail" />}
                    railWidth="standard"
                    detailMinWidthPx={480}
                    testID="settings-machines"
                    collectionHeader={<PageHeader testID="collection-header" title="Machines" />}
                />
            </SettingsFloatingControlsHost>,
        );
        await layoutAt(screen, 1200);
        const header = screen.root.findAll((node) => node.props?.testID === 'collection-header')[0];
        expect(header).toBeDefined();
        expect(header!.findAll((node) => node.props?.testID === 'settings-modal-back')).toHaveLength(0);
    });
});
