import { act, useState } from 'react';
import { describe, expect, it } from 'vitest';

import { ApprovalPrompt, Button, Text } from '@happier-dev/plugin-ui/components';
import { resolveHappierWorkStatusSurfaceStyle } from '../presentation/work/workStatus.js';
import { resolveHappierWorkTheme } from '../presentation/work/workTheme.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext, SURFACE_THEME_FIXTURE } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';

function AuthorFacts() {
  const [expanded, setExpanded] = useState(false);
  return <>
    <Text testID="facts" value={expanded ? 'Exact reviewed facts' : 'Review facts'} />
    <Button testID="show-facts" title="Show facts" onPress={() => setExpanded(true)} />
  </>;
}

/** Public-author composition: the caller owns the facts and the decision. */
function AuthorReview() {
  const [settled, setSettled] = useState(false);
  return (
    <ApprovalPrompt
      testID="review"
      title="Apply the reviewed change"
      subtitle="Requested by the project integration"
      icon={<Text testID="review-icon" value="!" />}
      chrome={settled ? 'inline' : 'card'}
      footer={settled ? <Text testID="outcome" value="Applied" /> : <Button testID="decide" title="Apply" onPress={() => setSettled(true)} />}
    >
      <AuthorFacts />
    </ApprovalPrompt>
  );
}

describe('public ApprovalPrompt', () => {
  it('keeps the caller facts mounted as its decision settles and its chrome changes', async () => {
    const context = createSurfaceContext();
    const mounted = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <AuthorReview />
      </PluginUiProvider>
    );
    try {
      expect(mounted.container.querySelector('[data-testid="review"]')?.textContent).toContain('Requested by the project integration');
      expect(mounted.container.querySelector('[data-testid="review-icon"]')).not.toBeNull();
      act(() => mounted.container.querySelector<HTMLElement>('[data-testid="show-facts"]')!.click());
      const facts = mounted.container.querySelector('[data-testid="facts"]');
      expect(facts?.textContent).toBe('Exact reviewed facts');
      act(() => mounted.container.querySelector<HTMLElement>('[data-testid="decide"]')!.click());
      expect(mounted.container.querySelector('[data-testid="facts"]')).toBe(facts);
      expect(mounted.container.querySelector('[data-testid="facts"]')?.textContent).toBe('Exact reviewed facts');
      expect(mounted.container.querySelector('[data-testid="decide"]')).toBeNull();
      expect(mounted.container.querySelector('[data-testid="outcome"]')?.textContent).toBe('Applied');
    } finally {
      mounted.unmount();
    }
  });

  it('reads as "needs you" in attention: the shared needs-you card ring and tint, while neutral stays plain', () => {
    const context = createSurfaceContext();
    const mounted = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <ApprovalPrompt testID="needs-you" tone="attention" title="Codex wants to run a command" />
        <ApprovalPrompt testID="quiet" title="Apply the reviewed change" />
      </PluginUiProvider>
    );
    try {
      const expected = resolveHappierWorkStatusSurfaceStyle('attention', resolveHappierWorkTheme(context.theme).colors);
      const needsYou = mounted.container.querySelector<HTMLElement>('[data-testid="needs-you"]')!;
      expect(needsYou.style.backgroundColor).toBe(expected.backgroundColor);
      expect(needsYou.style.borderTopColor).toBe(expected.borderColor);
      const quiet = mounted.container.querySelector<HTMLElement>('[data-testid="quiet"]')!;
      expect(quiet.style.backgroundColor).not.toBe(expected.backgroundColor);
      expect(quiet.style.borderTopColor).not.toBe(expected.borderColor);
    } finally {
      mounted.unmount();
    }
  });

  it('draws its title in a shipped face and its insets from the theme spacing', () => {
    const compact = { ...SURFACE_THEME_FIXTURE, spacing: { xsmall: 3, small: 6, medium: 10, large: 12, xlarge: 16 } };
    const context = createSurfaceContext({ theme: compact });
    const mounted = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <ApprovalPrompt testID="review" title="Apply the reviewed change" />
      </PluginUiProvider>
    );
    try {
      const title = [...mounted.container.querySelectorAll<HTMLElement>('[data-testid="review"] *')]
        .find((node) => node.textContent === 'Apply the reviewed change' && node.style.fontWeight !== '')!;
      // Inter ships 400/500/600 only (DESIGN.md); any other weight is a synthesized face.
      expect(['400', '500', '600']).toContain(title.style.fontWeight);
      const header = title.parentElement!.parentElement!;
      expect(header.style.paddingTop).toBe('10px');
      expect(header.style.paddingLeft).toBe('10px');
    } finally {
      mounted.unmount();
    }
  });
});
