import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { HAPPIER_COLLECTION_LIST_METRICS } from '@happier-dev/plugin-ui/presentation';
import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

afterEach(() => vi.unstubAllGlobals());

it('keeps a row menu trigger\'s finger reach inside its own row, so stacked rows never share a hit area', async () => {
    vi.stubGlobal('navigator', { maxTouchPoints: 1 });
    const { ProjectsListItemMenu } = await import('./ProjectsListItemMenu');
    const screen = await renderScreen(
        <ProjectsListItemMenu testID="row-menu" workspaceRef={null} onHideProject={() => {}}
            onTogglePinned={() => {}} onRename={() => {}} onReset={() => {}} onRemove={() => {}} />,
    );
    const trigger = screen.findHostByTestId('row-menu')!;
    await act(async () => trigger.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 24, height: 24 } } }));
    const frame = screen.root.findAll((node) => node.props?.dataSet?.happierHitArea === 'true')[0]!;
    // The row is at least `rowMinHeight` tall around the 24 px button: that slack is all it may reach into.
    const slack = (HAPPIER_COLLECTION_LIST_METRICS.rowMinHeight - 24) / 2;
    expect(frame.props.style.top).toBe(-slack);
    expect(frame.props.style.bottom).toBe(-slack);
});
