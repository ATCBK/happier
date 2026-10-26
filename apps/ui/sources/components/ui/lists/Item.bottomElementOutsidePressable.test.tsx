import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

await import('./Item');

afterEach(() => {
  standardCleanup();
  vi.resetModules();
});

async function renderRow(
  props: Readonly<{ outside: boolean; onPress?: () => void }>,
) {
  const { Item } = await import('./Item');
  const { Pressable } = await import('react-native');
  const screen = await renderScreen(
    <Item
      testID="row"
      title="Codex"
      onPress={props.onPress}
      bottomElement={<Pressable testID="inner" accessibilityRole="button" />}
      {...(props.outside ? { bottomElementOutsidePressable: true } : {})}
    />,
  );
  return screen;
}

function hasAncestor(
  screen: Awaited<ReturnType<typeof renderRow>>,
  id: string,
  ancestor: unknown,
) {
  let node = screen.findHostByTestId(id)?.parent;
  while (node) {
    if (node === ancestor) return true;
    node = node.parent;
  }
  return false;
}

describe('Item bottomElementOutsidePressable', () => {
  it('keeps a control in the bottom content out of the row button', async () => {
    const nested = await renderRow({ outside: false, onPress: () => {} });
    expect(
      hasAncestor(nested, 'inner', nested.findHostByTestId('row')),
    ).toBe(true);

    const sibling = await renderRow({ outside: true, onPress: () => {} });
    expect(sibling.findHostByTestId('row')?.type).toBe('Pressable');
    expect(
      hasAncestor(sibling, 'inner', sibling.findHostByTestId('row')),
    ).toBe(false);
  });

  it('still shows the bottom content when the row has no press of its own', async () => {
    const screen = await renderRow({ outside: true });
    expect(screen.findHostByTestId('inner')).toBeTruthy();
  });
});
