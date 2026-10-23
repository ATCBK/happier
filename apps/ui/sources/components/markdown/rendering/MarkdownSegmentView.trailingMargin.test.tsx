import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installMarkdownCommonModuleMocks } from '../markdownTestHelpers';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

installMarkdownCommonModuleMocks();

const { splitMarkdownRenderSegments } = await import('./splitMarkdownRenderSegments');
const { MarkdownSegmentView } = await import('./MarkdownSegmentView');

describe('MarkdownSegmentView trailing margin', () => {
  it('leaves descendants enabled when a source range has no review action', async () => {
    const [segment] = splitMarkdownRenderSegments({ markdown: 'Read this.', streamingMode: 'static', splitEnrichedSourceRanges: true });
    const screen = await renderScreen(<MarkdownSegmentView segment={segment!} selectable profile="document"
      streamingReveal={false} sourceRangeInteractionsActive agentTexMath={false} />);
    const trigger = screen.findByTestId('markdown-source-range-trigger:1-1');
    if (!trigger) throw new Error('Source-range wrapper was not rendered');
    expect(trigger.props.disabled).not.toBe(true);
    expect(trigger.props.accessibilityState?.disabled).not.toBe(true);
    expect(trigger.props.accessibilityRole).toBeUndefined();
    expect(trigger.props.tabIndex).toBe(-1);
    expect(trigger.props.focusable).toBe(false);

    const activations: string[] = [];
    const active = await renderScreen(<MarkdownSegmentView segment={segment!} selectable profile="document"
      streamingReveal={false} sourceRangeInteractionsActive agentTexMath={false}
      onPressSourceRange={action => activations.push(action.markdown)} />);
    const activeTrigger = active.findByTestId('markdown-source-range-trigger:1-1');
    if (!activeTrigger) throw new Error('Active source-range wrapper was not rendered');
    expect(activeTrigger.props.tabIndex).not.toBe(-1);
    expect(activeTrigger.props.focusable).toBe(true);
    await active.pressByTestIdAsync('markdown-source-range-trigger:1-1');
    expect(activations).toEqual(['Read this.']);
  });

  it('keeps the bottom margin of every split run but the document’s last, so paragraphs keep their rhythm', async () => {
    const segments = splitMarkdownRenderSegments({
      markdown: '# Demo project\n\nA small project.\n\nSee the notes.',
      streamingMode: 'static',
      splitEnrichedSourceRanges: true,
    });
    expect(segments.length).toBe(3);

    const screen = await renderScreen(
      <>
        {segments.map((segment) => (
          <MarkdownSegmentView
            key={segment.key}
            segment={segment}
            selectable
            profile="document"
            streamingReveal={false}
            sourceRangeInteractionsActive={false}
            agentTexMath={false}
          />
        ))}
      </>,
    );
    const runs = screen.tree.findAllByType('EnrichedMarkdownText' as never);
    expect(runs.map((run) => run.props.allowTrailingMargin)).toEqual([
      true,
      true,
      false,
    ]);
  });
});
