import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { PaneColumnsHost } from './PaneColumnsHost';
import { useOptionalAppPaneScopeLayout } from './hooks/useAppPaneScopeLayout';

// Window dimensions are a platform boundary; pane resolution and subscriptions stay real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ useWindowDimensions: () => ({ width: 1200, height: 800 }) });
});

const initialStorage = storage.getState();
afterEach(async () => {
    await standardCleanup();
    storage.setState(initialStorage, true);
});

it('retains pane layout subscribers across content updates and publishes an actual pane change', async () => {
    const snapshots: ReturnType<typeof useOptionalAppPaneScopeLayout>[] = [];
    const Probe = React.memo(function Probe() {
        snapshots.push(useOptionalAppPaneScopeLayout());
        return null;
    });
    const main = (content: string) => <><Probe />{content}</>;
    const screen = await renderScreen(<PaneColumnsHost testID="identity-pane-columns" main={main('first')} />);
    const before = snapshots.at(-1);
    expect(before).not.toBeNull();
    const renders = snapshots.length;
    await screen.update(<PaneColumnsHost testID="identity-pane-columns" main={main('second')} />);
    expect(snapshots).toHaveLength(renders);
    expect(snapshots.at(-1)).toBe(before);

    await screen.update(<PaneColumnsHost testID="identity-pane-columns" main={main('second')} rightPane={<div />} />);
    const withRightPane = snapshots.at(-1);
    expect(withRightPane).not.toBe(before);
    expect(withRightPane?.layout.right).not.toBe('hidden');
    const paneHost = screen.findByTestId('identity-pane-columns');
    if (!paneHost) throw new Error('Missing pane host');
    await act(async () => {
        paneHost.props.onLayout({ nativeEvent: { layout: { width: 375, height: 800 } } });
    });
    expect(snapshots.at(-1)?.containerWidthPx).toBe(375);
    expect(snapshots.at(-1)?.layout.kind).not.toBe(withRightPane?.layout.kind);
});

it('remembers dock dimensions and their viewport basis when the Settings Action is off', async () => {
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    storage.setState({ settings: settingsParse({
        actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
    }) });
    const screen = await renderScreen(<PaneColumnsHost main={<div />} />);
    const columns = screen.tree.find(node => typeof node.props.onCommitRightDockWidthPx === 'function');
    await act(async () => {
        columns.props.onCommitRightDockWidthPx(330);
        columns.props.onCommitDetailsDockWidthPx(470);
        columns.props.onCommitBottomDockHeightPx(260);
    });
    expect(storage.getState().localSettings).toMatchObject({
        rightPaneWidthPx: 330, rightPaneWidthBasisPx: 1200,
        detailsPaneWidthPx: 470, detailsPaneWidthBasisPx: 1200,
        bottomPaneHeightPx: 260, bottomPaneHeightBasisPx: 800,
    });
});
