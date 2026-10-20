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
await import('@/components/ui/text/Text');

afterEach(() => {
  standardCleanup();
  vi.resetModules();
});

/** The left padding of the wrapper that holds the row's bottom element: where its content starts. */
async function bottomStart(props: Readonly<{ withIcon: boolean; inset: 'row' | 'text' }>) {
  const { Item } = await import('./Item');
  const { Text } = await import('@/components/ui/text/Text');
  const { StyleSheet } = await import('react-native');
  const screen = await renderScreen(
    <Item
      title="Context7"
      density="compact"
      {...(props.withIcon ? { icon: <Text>mark</Text> } : {})}
      bottomElement={<Text testID="facts">2 tools</Text>}
      bottomElementInset={props.inset}
    />,
  );
  const holders = screen.findAll(
    (node) =>
      node.findAll((child) => child.props?.testID === 'facts').length > 0 &&
      typeof StyleSheet.flatten(node.props?.style)?.paddingLeft === 'number',
  );
  return StyleSheet.flatten(holders.at(-1)!.props.style).paddingLeft as number;
}

describe('Item bottomElementInset in a compact list row', () => {
  it('text starts the bottom element on the title edge, past the leading glyph', async () => {
    const row = await bottomStart({ withIcon: true, inset: 'row' });
    expect(await bottomStart({ withIcon: true, inset: 'text' })).toBeGreaterThan(row);
  });

  it('a row without a glyph has no title offset to follow', async () => {
    expect(await bottomStart({ withIcon: false, inset: 'text' })).toBe(
      await bottomStart({ withIcon: false, inset: 'row' }),
    );
  });
});
