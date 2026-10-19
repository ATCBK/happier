/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';

// Disabled presses are suppressed by the platform Pressable, not by Item's callback.
installUiListsCommonModuleMocks({ reactNative: async () => vi.importActual('react-native-web') });

const { ItemAddRow } = await import('./ItemAddRow');
const { ListPresentationProvider } = await import('./listPresentation');

describe('host add row shared composition', () => {
  it('retains controlled expansion and disables the real row activation', async () => {
    const onPress = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const button = (id: string) => {
      const target = container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      if (!target) throw new Error(`Missing add row ${id}`);
      return target;
    };
    try {
      await act(async () => root.render(<ListPresentationProvider value="page">
        <ItemAddRow testID="host-add" title="Add variable" expanded onPress={onPress} />
        <ItemAddRow testID="host-disabled-add" title="Add model" disabled onPress={onPress} />
      </ListPresentationProvider>));
      expect(button('host-add').getAttribute('aria-expanded')).toBe('true');
      await act(async () => button('host-add').click());
      expect(onPress).toHaveBeenCalledOnce();
      expect(button('host-disabled-add').getAttribute('aria-disabled')).toBe('true');
      await act(async () => button('host-disabled-add').click());
      expect(onPress).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
