import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { HappierSegmentedChoice } from './SegmentedChoice.js';

const COLORS = {
  track: 'rgb(1, 1, 1)',
  thumb: 'rgb(2, 2, 2)',
  label: 'rgb(3, 3, 3)',
  activeLabel: 'rgb(4, 4, 4)',
  focusRing: 'rgb(5, 5, 5)',
  inheritedThumbBorder: 'rgb(9, 9, 9)',
} as const;

const SEGMENTS = [
  {
    key: 'off',
    label: 'Off',
    selected: false,
    disabled: false,
    testID: 'tool:off',
  },
  {
    key: 'ask',
    label: 'Ask',
    selected: true,
    disabled: false,
    testID: 'tool:ask',
  },
  {
    key: 'allow',
    label: 'Allow',
    selected: false,
    disabled: false,
    testID: 'tool:allow',
  },
] as const;

function mount(valueSource?: 'set' | 'inherited') {
  return mountThroughReactNativeWeb(
    <HappierSegmentedChoice
      testID="tool"
      accessibilityLabel="Search code"
      segments={SEGMENTS}
      onSelect={() => undefined}
      colors={COLORS}
      {...(valueSource === undefined ? {} : { valueSource })}
    />,
  );
}

describe('segmented choice value source', () => {
  it('keeps an inherited choice selected and says it is the default', () => {
    const view = mount('inherited');
    const ask = view.container.querySelector('[data-testid="tool:ask"]');
    expect(ask?.getAttribute('aria-checked')).toBe('true');
    expect(ask?.getAttribute('aria-label')).toBe('Ask, default');
    expect(
      view.container
        .querySelector('[data-testid="tool:off"]')
        ?.getAttribute('aria-label'),
    ).toBe('Off');
    view.unmount();
  });

  it('draws a set choice exactly as before when no source is given', () => {
    const plain = mount();
    const set = mount('set');
    const plainAsk = plain.container.querySelector('[data-testid="tool:ask"]');
    expect(plainAsk?.getAttribute('aria-label')).toBe('Ask');
    expect(plainAsk?.getAttribute('aria-checked')).toBe('true');
    expect(set.container.innerHTML).toBe(plain.container.innerHTML);
    plain.unmount();
    set.unmount();
  });
});

describe('a scrollable segmented choice', () => {
  const COLUMNS = ['needs', 'agent', 'review', 'rest'].map((key, index) => ({
    key,
    label: key,
    selected: key === 'rest',
    disabled: false,
    testID: `column:${index}`,
  }));
  type LayoutNode = HTMLElement & { __reactLayoutHandler?: (event: unknown) => void };
  const layout = (node: Element | null, frame: { x: number; width: number }) => {
    act(() => (node as LayoutNode).__reactLayoutHandler?.({ nativeEvent: { layout: { y: 0, height: 28, ...frame } } }));
  };

  it('brings the chosen segment into view when it sits past the visible edge', () => {
    const scroll = vi.fn();
    const original = HTMLElement.prototype.scroll;
    // jsdom has no scroll geometry; the element's own scroll() is the platform boundary under test.
    HTMLElement.prototype.scroll = scroll as unknown as typeof original;
    const view = mountThroughReactNativeWeb(
      <HappierSegmentedChoice
        testID="columns"
        accessibilityLabel="Columns"
        scrollable
        segments={COLUMNS}
        onSelect={() => undefined}
        colors={COLORS}
      />,
    );
    const track = view.container.querySelector('[data-testid="columns"]')!;
    const scroller = track.parentElement!.parentElement!;
    layout(scroller, { x: 0, width: 300 });
    COLUMNS.forEach((column, index) => layout(
      view.container.querySelector(`[data-testid="column:${index}"]`)!.parentElement,
      { x: 2 + index * 110, width: 110 },
    ));
    expect(scroll).toHaveBeenCalledTimes(1);
    const left = (scroll.mock.calls[0]![0] as { left: number }).left;
    // The chosen segment (332..442) ends inside the 300px window it was scrolled into.
    expect(left).toBeGreaterThanOrEqual(442 - 300);
    expect(left).toBeLessThanOrEqual(332);
    view.unmount();
    HTMLElement.prototype.scroll = original;
  });
});
