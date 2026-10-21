import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installMarkdownCommonModuleMocks } from '../markdownTestHelpers';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

installMarkdownCommonModuleMocks();

const { splitMarkdownRenderSegments } = await import('./splitMarkdownRenderSegments');
const { MarkdownSegmentView } = await import('./MarkdownSegmentView');

describe('MarkdownSegmentView trailing margin', () => {
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
