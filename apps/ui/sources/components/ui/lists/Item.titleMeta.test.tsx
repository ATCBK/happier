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

// Collect the real component graph before the interaction-test deadline starts.
await import('./Item');
await import('@/components/ui/text/Text');

afterEach(() => {
  standardCleanup();
  vi.resetModules();
});

type Screen = Awaited<ReturnType<typeof renderScreen>>;
type Node = ReturnType<Screen['findAll']>[number];

const TITLE = 'systematic-debugging-with-a-very-long-name';

async function renderMetaRow() {
  const { Item } = await import('./Item');
  const { Text } = await import('@/components/ui/text/Text');
  return renderScreen(
    <Item title={TITLE} subtitle="Find the root cause before fixing." titleMeta={<Text testID="meta">Everywhere · except Gemini</Text>} onPress={() => {}} />,
  );
}

/** Layout is the platform boundary: the row's text column reports its width, the meta its natural width. */
async function layout(screen: Screen, widths: Readonly<{ row: number; meta: number }>) {
  const { act } = await import('react-test-renderer');
  const holders = () => screen.findAll((node) => typeof node.type === 'string' && typeof node.props?.onLayout === 'function');
  await act(async () => {
    for (const node of holders()) {
      const holdsMeta = node.findAll((child: Node) => child.props?.testID === 'meta').length > 0;
      const holdsTitle = node.findAll((child: Node) => child.props?.children === TITLE).length > 0;
      if (holdsMeta && holdsTitle) node.props.onLayout({ nativeEvent: { layout: { width: widths.row, height: 40, x: 0, y: 0 } } });
    }
  });
  await act(async () => {
    for (const node of holders()) {
      const holdsMeta = node.findAll((child: Node) => child.props?.testID === 'meta').length > 0;
      const holdsTitle = node.findAll((child: Node) => child.props?.children === TITLE).length > 0;
      if (holdsMeta && !holdsTitle) node.props.onLayout({ nativeEvent: { layout: { width: widths.meta, height: 18, x: 0, y: 0 } } });
    }
  });
}

/** The smallest host element holding both the title and the meta: their shared line, or the whole column. */
function sharesTitleLine(screen: Screen): boolean {
  const rows = screen.findAll((node) => typeof node.type === 'string'
    && node.findAll((child: Node) => child.props?.testID === 'meta').length > 0
    && node.findAll((child: Node) => child.props?.children === TITLE).length > 0
    && node.findAll((child: Node) => child.props?.children === 'Find the root cause before fixing.').length === 0);
  return rows.length > 0;
}

describe('Item titleMeta', () => {
  it('draws the meta whole on the title line, and moves it beneath the title when the line is too narrow', async () => {
    const screen = await renderMetaRow();
    await layout(screen, { row: 480, meta: 170 });
    expect(screen.findAll((node) => node.props?.testID === 'meta').length).toBeGreaterThan(0);
    expect(sharesTitleLine(screen)).toBe(true);

    await layout(screen, { row: 240, meta: 170 });
    // Still drawn whole, now on its own line under the title.
    expect(screen.findAll((node) => node.props?.testID === 'meta').length).toBeGreaterThan(0);
    expect(sharesTitleLine(screen)).toBe(false);
  });
});
