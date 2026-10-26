import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

afterEach(() => vi.unstubAllGlobals());

it('splits the bar\'s action gap with its neighbour instead of reaching into it', async () => {
    vi.stubGlobal('navigator', { maxTouchPoints: 1 });
    const { ScmComparisonMoreMenu } = await import('./ScmComparisonMoreMenu');
    const screen = await renderScreen(<ScmComparisonMoreMenu testID="bar-more" interactiveTargetGapPx={8}
        sections={[{ id: 'display', items: [{ id: 'wrap', title: 'Wrap' }], onSelect: () => {} }]} />);
    const trigger = screen.findHostByTestId('bar-more')!;
    await act(async () => trigger.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 28, height: 28 } } }));
    const frame = screen.root.findAll((node) => node.props?.dataSet?.happierHitArea === 'true')[0]!;
    // Half of the 8 px gap on each side; the 44 px target alone would reach 8.
    expect([-frame.props.style.left, -frame.props.style.right]).toEqual([4, 4]);
});
