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

describe('Item titleHighlightQuery', () => {
  it('tints the query inside a string title and leaves a title without the query plain', async () => {
    const { Item } = await import('./Item');
    const matched = await renderScreen(
      <Item title="Reply with exactly: amber orchard, silver meadow." titleHighlightQuery="silver meadow" onPress={() => {}} />,
    );
    expect(matched.findAllHostsByTestId('find-match-all')).toHaveLength(1);
    // The testkit separates adjacent text nodes with a space at the highlight boundary.
    expect(matched.getTextContent()).toMatch(/Reply with exactly: amber orchard, silver meadow\s*\./);
    const plain = await renderScreen(
      <Item title="Fix settings modal remount" titleHighlightQuery="silver meadow" onPress={() => {}} />,
    );
    expect(plain.findAllHostsByTestId('find-match-all')).toHaveLength(0);
  });
});
