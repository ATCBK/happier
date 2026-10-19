import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { MachineTabSubHead } from '@/components/machines/page/MachineTabSubHead';

const routeState = vi.hoisted(() => ({ pathname: '/settings/appearance/themes' }));

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => routeState.pathname }).module;
});

import { SettingsFloatingControlsHost } from './SettingsModalFloatingControls';

type Screen = Awaited<ReturnType<typeof renderScreen>>;
let screen: Screen | null = null;

afterEach(async () => {
    await screen?.unmount();
    screen = null;
    routeState.pathname = '/settings/appearance/themes';
});

function backControls(): readonly unknown[] {
    return screen?.findAllHostsByTestId('settings-modal-back') ?? [];
}

function headerHoldsBack(headerTestID: string): boolean {
    const header = screen?.findByTestId(headerTestID);
    return (header?.findAll((node) => node.props?.testID === 'settings-modal-back').length ?? 0) > 0;
}

it('puts the back control on the page header title line instead of floating it over the page', async () => {
    screen = await renderScreen(
        <SettingsFloatingControlsHost enabled>
            <PageHeader testID="page-header" title="Themes" />
        </SettingsFloatingControlsHost>,
    );

    expect(backControls()).toHaveLength(1);
    expect(headerHoldsBack('page-header')).toBe(true);
});

it('only lets the focused hosted page claim inline Back chrome', async () => {
    screen = await renderScreen(<>
        {[true, false].map((focused, index) => <DestinationInstanceHost key={index}
            tabId={`settings-${index}`} ref={{ kind: 'settings', params: { pageId: 'appearance/themes' } }}
            pathname="/settings/appearance/themes" focused={focused} visible
            navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
            <SettingsFloatingControlsHost enabled>
                <PageHeader testID={`header-${index}`} title="Themes" />
            </SettingsFloatingControlsHost>
        </DestinationInstanceHost>)}
    </>);
    expect(headerHoldsBack('header-0')).toBe(true);
    expect(headerHoldsBack('header-1')).toBe(false);
});

it('lets a page head that draws its own named way back be the only Back (no floating control beside it)', async () => {
    routeState.pathname = '/settings/machines/machine-1/agents';
    screen = await renderScreen(
        <SettingsFloatingControlsHost enabled>
            <MachineTabSubHead title="Agents" placement="page"
                back={{ label: 'nl2', onPress: () => {}, testID: 'machine-sub-page-back-agents' }} />
        </SettingsFloatingControlsHost>,
    );

    expect(backControls()).toHaveLength(0);
    expect(screen.findAllHostsByTestId('machine-sub-page-back-agents')).toHaveLength(1);
});

it('keeps a back control on a sub-page that has no page header yet', async () => {
    screen = await renderScreen(
        <SettingsFloatingControlsHost enabled>
            <></>
        </SettingsFloatingControlsHost>,
    );

    expect(backControls()).toHaveLength(1);
});

it('shows no back control on a page reached from the rail', async () => {
    routeState.pathname = '/settings/appearance';
    screen = await renderScreen(
        <SettingsFloatingControlsHost enabled>
            <PageHeader testID="page-header" title="Appearance" />
        </SettingsFloatingControlsHost>,
    );

    expect(backControls()).toHaveLength(0);
});

it('in a detail beside its list, gives back only to pages below the list item, on their title line', async () => {
    const renderAt = async (pathname: string) => {
        routeState.pathname = pathname;
        await screen?.unmount();
        screen = await renderScreen(
            <SettingsFloatingControlsHost enabled>
                <SettingsFloatingControlsHost enabled collectionRootPathname="/settings/providers">
                    <PageHeader testID="detail-header" title="Detail" />
                </SettingsFloatingControlsHost>
            </SettingsFloatingControlsHost>,
        );
    };

    // The list is beside this detail, so nothing leads back to it (and nothing floats over the list).
    await renderAt('/settings/providers/connection-1');
    expect(backControls()).toHaveLength(0);

    await renderAt('/settings/providers/connection-1/models');
    expect(backControls()).toHaveLength(1);
    expect(headerHoldsBack('detail-header')).toBe(true);
});

it('gives a collection-root detail no back at all: no line above its title, no gutter slot, at any pane width', async () => {
    routeState.pathname = '/settings/providers/connection-1';
    screen = await renderScreen(
        <SettingsFloatingControlsHost enabled>
            <SettingsFloatingControlsHost enabled collectionRootPathname="/settings/providers">
                <PageHeader testID="detail-header" title="Detail" />
            </SettingsFloatingControlsHost>
        </SettingsFloatingControlsHost>,
    );
    const empty = () => {
        expect(backControls()).toHaveLength(0);
        expect(screen?.findByTestId('detail-header-back-line')).toBeNull();
        expect(screen?.findByTestId('detail-header-back-gutter')).toBeNull();
    };
    empty();
    // A narrow detail pane (the column fills it), where a shown back would take its own line.
    const header = screen.root.find((node) => typeof node.type === 'string' && node.props.testID === 'detail-header');
    await act(async () => {
        header.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 420, height: 80 } } });
    });
    empty();
});
