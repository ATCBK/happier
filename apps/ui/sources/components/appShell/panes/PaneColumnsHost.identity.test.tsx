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

it('remembers fixed dock dimensions when the Settings Action is off', async () => {
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    storage.setState({ settings: settingsParse({
        actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
    }) });
    const screen = await renderScreen(<PaneColumnsHost main={<div />} />);
    const columns = screen.tree.find(node => typeof node.props.onCommitBottomDockHeightPx === 'function');
    await act(async () => {
        columns.props.onCommitRightDockWidthPx(330);
        columns.props.onCommitDetailsDockWidthPx(470);
        columns.props.onCommitBottomDockHeightPx(260);
    });
    expect(storage.getState().localSettings).toMatchObject({
        rightPaneWidthPx: 330,
        detailsPaneWidthPx: 470,
        bottomPaneHeightPx: 260,
    });
    const { localSettingsDefaults } = await import('@/sync/domains/settings/localSettings');
    await act(async () => {
        columns.props.onResetRightDockWidthPx(); columns.props.onResetDetailsDockWidthPx();
        columns.props.onResetMainDockWidthPx(); columns.props.onResetBottomDockHeightPx();
    });
    expect(storage.getState().localSettings).toMatchObject({
        rightPaneWidthPx: localSettingsDefaults.rightPaneWidthPx,
        detailsPaneWidthPx: localSettingsDefaults.detailsPaneWidthPx,
        sessionColumnWidthPx: localSettingsDefaults.sessionColumnWidthPx,
        bottomPaneHeightPx: localSettingsDefaults.bottomPaneHeightPx,
    });
});

it('opens only a folded session drawer and forgets transient opening on leaving editor-first', async () => {
    const layouts: ReturnType<typeof useOptionalAppPaneScopeLayout>[] = [];
    const controls: { current: Readonly<{ open: () => void; close: () => void }> | null } = { current: null };
    const Probe = () => { layouts.push(useOptionalAppPaneScopeLayout()); return null; };
    const onControls = (value: typeof controls.current) => { controls.current = value; };
    const host = (arrangement: 'session' | 'editor') => <PaneColumnsHost testID="drawer-columns"
        main={<Probe />} arrangement={arrangement} emptyEditorPane={<div />} onMainDrawerControlsChange={onControls} />;
    const screen = await renderScreen(host('session'));
    await act(async () => controls.current?.open());
    expect(layouts.at(-1)?.mainDrawerOpen).toBe(false);
    await screen.update(host('editor'));
    const root = screen.findByTestId('drawer-columns');
    await act(async () => root!.props.onLayout({ nativeEvent: { layout: { width: 834, height: 800 } } }));
    expect(layouts.at(-1)?.layout.main).toBe('overlay');
    expect(layouts.at(-1)?.mainDrawerOpen).toBe(false);
    await act(async () => controls.current?.open());
    expect(layouts.at(-1)?.mainDrawerOpen).toBe(true);
    await screen.update(host('session'));
    expect(layouts.at(-1)?.mainDrawerOpen).toBe(false);
    await screen.update(host('editor'));
    await act(async () => root!.props.onLayout({ nativeEvent: { layout: { width: 1440, height: 800 } } }));
    await act(async () => controls.current?.open());
    expect(layouts.at(-1)?.mainDrawerOpen).toBe(false);
});
