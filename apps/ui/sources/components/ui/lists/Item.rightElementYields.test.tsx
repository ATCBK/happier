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

type Screen = Awaited<ReturnType<typeof renderScreen>>;
type Node = ReturnType<Screen['findAll']>[number];

const TITLE = 'NLDW3-5-36-33';

async function renderRailRow(yields: boolean) {
  const { Item } = await import('./Item');
  const { Text } = await import('@/components/ui/text/Text');
  return renderScreen(
    <Item title={TITLE} titleLines={1} density="compact" showChevron={false}
      rightElement={<Text testID="strip">CPU · Memory · Disk</Text>}
      {...(yields ? { rightElementYields: true } : {})} onPress={() => {}} />,
  );
}

const holds = (node: Node, predicate: (child: Node) => boolean) => node.findAll(predicate).length > 0;
const isStrip = (child: Node) => child.props?.testID === 'strip';
const isTitle = (child: Node) => child.props?.children === TITLE;

/** Layout is the platform boundary: the title's column reports its width, the trailing facts their natural width. */
async function layout(screen: Screen, widths: Readonly<{ title: number; strip: number; natural?: number }>) {
  const { act } = await import('react-test-renderer');
  const holders = () => screen.findAll((node) => typeof node.type === 'string' && typeof node.props?.onLayout === 'function');
  await act(async () => {
    for (const node of holders()) {
      // The name at its natural width (out of flow), then the title's column as laid out.
      if (isTitle(node)) node.props.onLayout({ nativeEvent: { layout: { width: widths.natural ?? 300, height: 20, x: 0, y: 0 } } });
      else if (holds(node, isTitle) && !holds(node, isStrip)) node.props.onLayout({ nativeEvent: { layout: { width: widths.title, height: 20, x: 0, y: 0 } } });
      else if (holds(node, isStrip) && !holds(node, isTitle)) node.props.onLayout({ nativeEvent: { layout: { width: widths.strip, height: 18, x: 0, y: 0 } } });
    }
  });
}

function stripShown(screen: Screen): boolean {
  const { StyleSheet } = require('react-native') as typeof import('react-native');
  const strip = screen.findAll(isStrip)[0];
  if (!strip) return false;
  for (let node: Node | null = strip; node; node = node.parent) {
    if (typeof node.type === 'string' && StyleSheet.flatten(node.props?.style)?.display === 'none') return false;
  }
  return true;
}

describe('Item rightElementYields', () => {
  it('steps trailing facts aside whole when the title would fall below its floor, and brings them back when there is room', async () => {
    const screen = await renderRailRow(true);
    await layout(screen, { title: 260, strip: 90 });
    expect(stripShown(screen)).toBe(true);
    // A narrow rail: the name is squeezed to a few characters beside the facts.
    await layout(screen, { title: 40, strip: 90 });
    expect(stripShown(screen)).toBe(false);
    // With the facts away the name has the whole line; that room still cannot hold both.
    await layout(screen, { title: 200, strip: 90 });
    expect(stripShown(screen)).toBe(false);
    // Widened again: the facts return.
    await layout(screen, { title: 320, strip: 90 });
    expect(stripShown(screen)).toBe(true);
  });

  it('keeps the facts beside a short name that fits whole', async () => {
    const screen = await renderRailRow(true);
    await layout(screen, { title: 70, strip: 90, natural: 60 });
    expect(stripShown(screen)).toBe(true);
  });

  it('keeps an ordinary trailing element in place', async () => {
    const screen = await renderRailRow(false);
    await layout(screen, { title: 40, strip: 90 });
    expect(stripShown(screen)).toBe(true);
  });
});
