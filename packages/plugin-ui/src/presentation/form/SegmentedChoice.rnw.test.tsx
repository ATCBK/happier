import { describe, expect, it } from 'vitest';

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
