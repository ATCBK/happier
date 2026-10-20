import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { flattenTestStyle, renderScreen } from '@/dev/testkit';
import {
  resolveItemGroupContentHorizontalInsetPx,
  resolveItemGroupHeaderHorizontalInsetPx,
} from '@/components/ui/lists/itemGroupSpacing';

import { SelectionList } from '../SelectionList';
import type { SelectionListStep } from '../_types';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

const rootStep: SelectionListStep = {
  id: 'root',
  sections: [
    {
      kind: 'static',
      id: 'picks',
      title: 'Added by hand',
      options: [
        {
          id: 'picks',
          label: '2 items',
          subtitle: 'Release captain, Verify release fixes',
        },
      ],
    },
  ],
};

async function renderList(optionPresentation?: 'section') {
  const screen = await renderScreen(
    <SelectionList
      rootStep={rootStep}
      onSelect={vi.fn()}
      onRequestClose={vi.fn()}
      disableTransitions
      testID="sl"
      {...(optionPresentation ? { optionPresentation } : {})}
    />,
  );
  const header = screen.findAll(
    (node) =>
      typeof node.type === 'string' &&
      String(node.props.testID ?? '').endsWith(':header'),
  )[0]!;
  const row = screen.findByTestId('sl:root:option-wrapper:picks')!;
  return {
    headerInset: Number(
      flattenTestStyle(header.props.style).paddingHorizontal ?? 0,
    ),
    rowInset: Number(flattenTestStyle(row.props.style).marginHorizontal ?? 0),
  };
}

// A settings body that mixes the list's sections with ItemGroup sections (Board settings) has one
// left edge: section presentation puts titles and rows on the grouped section's insets.
describe('SelectionList section presentation', () => {
  it('places section titles and rows on the grouped ItemGroup insets, while the default list keeps its flush rows', async () => {
    const section = await renderList('section');
    expect(section.headerInset).toBe(resolveItemGroupHeaderHorizontalInsetPx());
    expect(section.rowInset).toBe(resolveItemGroupContentHorizontalInsetPx());

    const row = await renderList();
    expect(row.rowInset).toBe(0);
    expect(row.headerInset).toBeLessThan(
      resolveItemGroupHeaderHorizontalInsetPx(),
    );
  });
});
