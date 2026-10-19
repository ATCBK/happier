import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

afterEach(() => {
  standardCleanup();
  vi.resetModules();
});

describe('Item without a press of its own', () => {
  it('still tells its owner when the pointer enters and leaves (a Reset that reveals on hover)', async () => {
    const { act } = await import('react-test-renderer');
    const { Item } = await import('./Item');
    const onHoverIn = vi.fn();
    const onHoverOut = vi.fn();
    const screen = await renderScreen(
      <Item testID="row" title="Builder" onHoverIn={onHoverIn} onHoverOut={onHoverOut} />,
    );
    const host = screen.findHostByTestId('row')!;
    await act(async () => { host.props.onPointerEnter(); });
    expect(onHoverIn).toHaveBeenCalledOnce();
    await act(async () => { host.props.onPointerLeave(); });
    expect(onHoverOut).toHaveBeenCalledOnce();
  });
});
