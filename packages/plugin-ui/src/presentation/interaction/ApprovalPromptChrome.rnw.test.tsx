import { View } from 'react-native';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { HappierApprovalPromptChrome, type HappierApprovalPromptChromeProps } from './ApprovalPromptChrome.js';

const base: HappierApprovalPromptChromeProps = {
  title: 'Open machine terminal',
  cardRadius: 12,
  colors: { border: '#ddd', surface: '#fff', title: '#111', subtitle: '#666',
    status: { secondaryText: '#666', attention: { foreground: '#a60', background: '#fff7ec', border: '#f90' },
      danger: { foreground: '#b00', background: '#fee', border: '#f66' } } },
  spacing: { small: 8, medium: 12 },
  typography: null,
};

function mount(maxHeight?: number) {
  return mountThroughReactNativeWeb(<HappierApprovalPromptChrome {...base} testID="card" maxHeight={maxHeight}
    footer={<View testID="decision" />}>
    <View testID="facts" />
  </HappierApprovalPromptChrome>);
}

describe('HappierApprovalPromptChrome', () => {
  it('keeps the decision outside the scrolling facts when the card is bounded', () => {
    const mounted = mount(240);
    try {
      const card = mounted.container.querySelector('[data-testid="card"]') as HTMLElement;
      const facts = mounted.container.querySelector('[data-testid="facts"]') as HTMLElement;
      const decision = mounted.container.querySelector('[data-testid="decision"]') as HTMLElement;
      expect(card.style.maxHeight).toBe('240px');
      // The facts scroll inside the card; the decision is pinned beneath them, never inside that scroll.
      const factsScroller = facts.closest('[data-testid="card-facts"]') as HTMLElement | null;
      expect(factsScroller).not.toBeNull();
      expect(factsScroller!.contains(decision)).toBe(false);
      expect(card.contains(decision)).toBe(true);
    } finally { mounted.unmount(); }
  });

  it('never clips the facts of a card that has no decision to pin', () => {
    // A failed or settled card closes from its head: nothing needs pinning, so a shared room scrolls whole
    // cards between each other instead of cutting this card's last line in half.
    const mounted = mountThroughReactNativeWeb(<HappierApprovalPromptChrome {...base} testID="card" maxHeight={90}>
      <View testID="facts" />
    </HappierApprovalPromptChrome>);
    try {
      const card = mounted.container.querySelector('[data-testid="card"]') as HTMLElement;
      expect(card.style.maxHeight).toBe('');
      expect(mounted.container.querySelector('[data-testid="card-facts"]')).toBeNull();
    } finally { mounted.unmount(); }
  });

  it('lets an unbounded card grow with its facts', () => {
    const mounted = mount();
    try {
      const card = mounted.container.querySelector('[data-testid="card"]') as HTMLElement;
      expect(card.style.maxHeight).toBe('');
      expect(mounted.container.querySelector('[data-testid="decision"]')).not.toBeNull();
    } finally { mounted.unmount(); }
  });
});
