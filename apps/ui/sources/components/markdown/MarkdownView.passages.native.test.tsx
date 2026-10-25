import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installMarkdownCommonModuleMocks } from './markdownTestHelpers';

installMarkdownCommonModuleMocks({
  reactNative: async () => {
    const { createReactNativeNativeMock } =
      await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
  },
});

const markdown = '# Runbook\n\nA replay shows one row.\n\nEscalate to on-call.';

type ContextMenuItem = Readonly<{
  text: string;
  onPress: (event: {
    text: string;
    selection: { start: number; end: number };
  }) => void;
}>;

describe('Native Markdown passages', () => {
  it('offers a selection action on each rendered block and reports that block’s place in the source', async () => {
    const { MarkdownView } = await import('./MarkdownView');
    const chosen: Array<
      Readonly<{ sourceStart: number; sourceLength: number }>
    > = [];
    const screen = await renderScreen(
      <MarkdownView
        markdown={markdown}
        selectionActions={[
          {
            label: 'Comment',
            onPress: (block) => {
              chosen.push(block);
            },
          },
        ]}
      />,
    );
    const runs = screen.findAllByType('EnrichedMarkdownText');
    expect(runs.length).toBeGreaterThanOrEqual(3);
    const paragraph = runs.find((run) =>
      String(run.props.markdown).includes('A replay'),
    )!;
    const items = paragraph.props
      .contextMenuItems as readonly ContextMenuItem[];
    expect(items.map((item) => item.text)).toEqual(['Comment']);
    // The renderer's selection offsets are its own drawn text; only the block's source place is trusted.
    await act(async () =>
      items[0]!.onPress({ text: 'replay', selection: { start: 2, end: 8 } }),
    );
    expect(chosen).toHaveLength(1);
    expect(
      markdown.slice(
        chosen[0]!.sourceStart,
        chosen[0]!.sourceStart + chosen[0]!.sourceLength,
      ),
    ).toContain('A replay shows one row.');
  });

  it('marks commented passages at their source offsets, only in the blocks they touch, and opens a marked block on tap', async () => {
    const { MarkdownView } = await import('./MarkdownView');
    const start = markdown.indexOf('one row');
    const pressed: number[] = [];
    const screen = await renderScreen(
      <MarkdownView
        markdown={markdown}
        sourceMarkKind="passage"
        findSourceRanges={[{ start, end: start + 7, current: false }]}
        selectionActions={[{ label: 'Comment', onPress: () => undefined }]}
        sourceRangePressable={(block) =>
          block.sourceStart <= start &&
          start < block.sourceStart + block.sourceLength
        }
        onPressSourceRange={(block) => {
          pressed.push(block.sourceStart);
        }}
      />,
    );
    expect(
      screen
        .findAllHostsByTestId('passage-mark')
        .map((node) => node.children.join('')),
    ).toEqual(['one row']);
    expect(screen.findAllHostsByTestId('find-match-all')).toHaveLength(0);
    // Blocks without a passage keep the native renderer and its selection action.
    const runs = screen.findAllByType('EnrichedMarkdownText');
    expect(runs.map((run) => String(run.props.markdown))).toEqual([
      '# Runbook',
      'Escalate to on-call.',
    ]);
    const triggers = screen
      .findAllByType('Pressable')
      .filter((node) =>
        String(node.props.testID ?? '').startsWith(
          'markdown-source-range-trigger',
        ),
      );
    // Only the marked block is interactive; inactive ranges pass pointers to their descendants.
    expect(triggers.map((node) => node.props.focusable)).toEqual([
      false,
      true,
      false,
    ]);
    await act(async () => triggers[1]!.props.onPress());
    expect(pressed).toEqual([markdown.indexOf('A replay')]);
  });
});
