import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';

installUiListsCommonModuleMocks();
afterEach(standardCleanup);

describe('host add row shared composition', () => {
  it('retains controlled expansion and disables the real row activation', async () => {
    const { ItemAddRow } = await import('./ItemAddRow');
    const { ListPresentationProvider } = await import('./listPresentation');
    const onPress = vi.fn();
    const screen = await renderScreen(<ListPresentationProvider value="page">
      <ItemAddRow testID="host-add" title="Add variable" expanded onPress={onPress} />
      <ItemAddRow testID="host-disabled-add" title="Add model" disabled onPress={onPress} />
    </ListPresentationProvider>);
    const button = (id: string) => screen.root.findAll(node => typeof node.type === 'string' && node.props.testID === id && node.props.accessibilityRole === 'button')[0]!;
    expect(button('host-add').props.accessibilityState.expanded).toBe(true);
    await act(async () => button('host-add').props.onPress());
    expect(onPress).toHaveBeenCalledOnce();
    expect(button('host-disabled-add').props.accessibilityState.disabled).toBe(true);
    await act(async () => button('host-disabled-add').props.onPress?.());
    expect(onPress).toHaveBeenCalledOnce();
  });
});
