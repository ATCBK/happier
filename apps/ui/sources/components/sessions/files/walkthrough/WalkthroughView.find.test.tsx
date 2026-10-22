// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import {
  SPECIMEN_ANALYSIS_COMPLETE,
  SPECIMEN_COMPARISON,
  SPECIMEN_WALKTHROUGH,
} from '@/components/dev/changes/walkthroughSpecimenFixture';
import { KeyboardShortcutProvider } from '@/keyboard/KeyboardShortcutProvider';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { executeFindAction } from '@/keyboard/findActionRuntime';

import { buildWalkthroughReading } from './walkthroughReading';

// Focus and Find registration need the actual RNW DOM boundary.
vi.mock('react-native', async () => await import('react-native-web'));
// Renderer leaves are host elements that expose what the reading asked them to draw; Find and reveal decisions run for real.
vi.mock('@/components/ui/code/diff/DiffViewer', () => ({
  DiffViewer: (props: {
    filePath?: string;
    scrollToLineId?: string;
    findRangesByLineId?: ReadonlyMap<string, unknown>;
  }) =>
    React.createElement('div', {
      'data-testid': `diff:${props.filePath}`,
      'data-target': props.scrollToLineId ?? '',
      'data-marked': String(props.findRangesByLineId?.size ?? 0),
    }),
}));
vi.mock('@/components/markdown/MarkdownView', () => ({
  MarkdownView: () => null,
}));

const { WalkthroughView } = await import('./WalkthroughView');

const STOPS = SPECIMEN_WALKTHROUGH.stops.map((stop) =>
  stop.id === 'why'
    ? {
        ...stop,
        suggestedQuestions: [
          'Why not key by width at all?',
          'Does the draft survive a rotation?',
        ],
      }
    : stop,
);
const reading = buildWalkthroughReading({
  comparison: SPECIMEN_COMPARISON,
  walkthrough: {
    state: 'complete',
    value: { ...SPECIMEN_WALKTHROUGH, stops: STOPS },
  },
  analysis: SPECIMEN_ANALYSIS_COMPLETE,
  reviewed: null,
});

async function mount(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <KeyboardShortcutProvider handlers={{}}>
        <PluginSurfaceFocusEligibilityProvider active>
          {element}
        </PluginSurfaceFocusEligibilityProvider>
      </KeyboardShortcutProvider>,
    );
  });
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

const find = (input: Record<string, unknown>) =>
  executeFindAction({
    actionId: 'ui.find',
    input: { target: 'walkthrough:test', ...input } as never,
    context: { surface: 'agent' },
  });

describe('Find in the walkthrough reading', () => {
  it('opens the code of a change outside the stops when Find lands on it, and folds it again when Find closes', async () => {
    const view = await mount(
      <WalkthroughView
        reading={reading}
        scopeLabel="This session"
        layout="wide"
        findSurfaceId="walkthrough:test"
      />,
    );
    const tail = () =>
      view.container.querySelector(
        '[data-testid="walkthrough-other-code-yarn.lock"]',
      );
    try {
      expect(tail()).toBeNull();
      let result: Awaited<ReturnType<typeof find>> | undefined;
      await act(async () => {
        result = await find({ op: 'set', query: '0.4.2' });
      });
      expect(result).toMatchObject({
        ok: true,
        result: { status: 'results', total: 2, current: 1 },
      });
      expect(tail()).not.toBeNull();
      const diff = tail()!.querySelector('[data-testid="diff:yarn.lock"]')!;
      expect(diff.getAttribute('data-target')).not.toBe('');
      expect(diff.getAttribute('data-marked')).toBe('2');
      await act(async () => {
        await find({ op: 'close' });
      });
      expect(tail()).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it("offers a stop's suggested questions beside its Ask and hands the chosen one to Ask", async () => {
    const onAsk = vi.fn();
    const view = await mount(
      <WalkthroughView
        reading={reading}
        scopeLabel="This session"
        layout="wide"
        onAsk={onAsk}
      />,
    );
    try {
      const question = view.container.querySelector<HTMLElement>(
        '[data-testid="walkthrough-question-why-1"]',
      );
      expect(question?.textContent).toBe('Does the draft survive a rotation?');
      expect(
        view.container.querySelector(
          '[data-testid="walkthrough-questions-sheet"]',
        ),
      ).toBeNull();
      await act(async () => {
        question!.click();
      });
      expect(onAsk).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'why' }),
        'Does the draft survive a rotation?',
      );
    } finally {
      await view.unmount();
    }
  });
});
