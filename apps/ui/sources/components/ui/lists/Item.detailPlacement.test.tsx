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

afterEach(() => {
  standardCleanup();
  vi.resetModules();
});

type Screen = Awaited<ReturnType<typeof renderScreen>>;
type Node = ReturnType<Screen['findAll']>[number];

async function renderDetailRow(detail: string) {
  const { Item } = await import('./Item');
  const { ListPresentationProvider } = await import('./listPresentation');
  return renderScreen(
    <ListPresentationProvider value="page">
      <Item
        title="Advanced"
        detail={detail}
        detailTestID="detail"
        onPress={() => {}}
      />
    </ListPresentationProvider>,
  );
}

/** Layout is the platform boundary: the row reports its width, the detail its natural width. */
async function layout(
  screen: Screen,
  widths: Readonly<{ row: number; detail: number }>,
) {
  const { act } = await import('react-test-renderer');
  const measured = () =>
    screen.findAll(
      (node) =>
        typeof node.type === 'string' &&
        typeof node.props?.onLayout === 'function',
    );
  await act(async () => {
    measured()[0]!.props.onLayout({
      nativeEvent: { layout: { width: widths.row, height: 52, x: 0, y: 0 } },
    });
  });
  await act(async () => {
    for (const node of measured().slice(1)) {
      if (
        node.findAll(
          (child: Node) =>
            child.props?.children ===
            'Service identity · API tokens · Encryption',
        ).length > 0 ||
        node.findAll((child: Node) => child.props?.children === '0.2.10')
          .length > 0
      ) {
        node.props.onLayout({
          nativeEvent: {
            layout: { width: widths.detail, height: 20, x: 0, y: 0 },
          },
        });
      }
    }
  });
}

/** The visible detail: the one a reader sees (testID), and whether it is clamped to one line. */
function visibleDetail(screen: Screen) {
  const nodes = screen.findAll(
    (node) => typeof node.type === 'string' && node.props?.testID === 'detail',
  );
  expect(nodes).toHaveLength(1);
  return nodes[0]!;
}

function sharesTitleColumn(screen: Screen, detail: Node): boolean {
  // Beneath the title: the detail and the title sit in the same text column.
  return (
    screen.findAll(
      (node) =>
        typeof node.type === 'string' &&
        node.findAll((child: Node) => child === detail).length > 0 &&
        node.findAll((child: Node) => child.props?.children === 'Advanced')
          .length > 0 &&
        node.findAll(
          (child: Node) => typeof child.props?.onLayout === 'function',
        ).length === 0,
    ).length > 0
  );
}

describe('Item page row detail placement', () => {
  it('moves a summary that would squeeze its label beneath the title on a narrow row, unclamped', async () => {
    const screen = await renderDetailRow(
      'Service identity · API tokens · Encryption',
    );
    await layout(screen, { row: 358, detail: 260 });
    const detail = visibleDetail(screen);
    expect(sharesTitleColumn(screen, detail)).toBe(true);
    expect(detail.props.numberOfLines ?? null).toBeNull();
  });

  it('keeps a short value trailing beside its label on a narrow row', async () => {
    const screen = await renderDetailRow('0.2.10');
    await layout(screen, { row: 358, detail: 44 });
    expect(sharesTitleColumn(screen, visibleDetail(screen))).toBe(false);
  });

  it('keeps a summary trailing on a wide row', async () => {
    const screen = await renderDetailRow(
      'Service identity · API tokens · Encryption',
    );
    await layout(screen, { row: 820, detail: 260 });
    expect(sharesTitleColumn(screen, visibleDetail(screen))).toBe(false);
  });
});
