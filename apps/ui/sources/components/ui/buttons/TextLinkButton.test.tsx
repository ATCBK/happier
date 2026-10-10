import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { renderScreen } from '@/dev/testkit';

// A finger is the primary pointer (the platform fact the touch floor reads); everything above it is real.
vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeNativeMock({ platformOS: 'ios' });
});

const { TextLinkButton } = await import('./TextLinkButton');

function flattenStyle(styleProp: unknown): Record<string, unknown> {
  const resolved =
    typeof styleProp === 'function'
      ? (styleProp as (s: Record<string, boolean>) => unknown)({
          pressed: false,
          hovered: false,
          focused: false,
          selected: false,
          highlighted: false,
          busy: false,
          disabled: false,
        })
      : styleProp;
  const entries = Array.isArray(resolved)
    ? (resolved as unknown[]).flat(Infinity)
    : [resolved];
  return Object.assign({}, ...(entries.filter(Boolean) as object[]));
}

describe('TextLinkButton', () => {
  it('reaches the touch floor with a real press frame that overhangs its line, not inert hit slop', async () => {
    const screen = await renderScreen(
      <TextLinkButton
        testID="link"
        label="Don't show again"
        onPress={() => {}}
      />,
    );
    const link = screen.findByTestId('link')!;
    const frame = flattenStyle(link.props.style);
    const line = happierPageTextMetrics('rowDescription').lineHeight;
    const grow = (44 - line) / 2;
    // react-native-web's Pressable ignores hitSlop, so the target is box model on every platform.
    expect(link.props.hitSlop ?? 0).toBe(0);
    expect(frame.paddingTop).toBe(grow);
    expect(frame.paddingBottom).toBe(grow);
    // None of it in flow: the words keep the sentence's line and baseline.
    expect(frame.marginTop).toBe(-grow);
    expect(frame.marginBottom).toBe(-grow);
    // Never sideways: the target does not reach over the words beside it.
    expect(frame.marginLeft ?? 0).toBe(0);
    expect(frame.marginRight ?? 0).toBe(0);
  });
});
