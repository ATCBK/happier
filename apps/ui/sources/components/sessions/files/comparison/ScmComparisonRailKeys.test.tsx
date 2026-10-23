import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import {
  KeyboardShortcutLabelsContext,
  type KeyboardShortcutLabels,
} from '@/keyboard/shortcutLabels';
import type { KeyboardCommandId } from '@/keyboard/types';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});

const entries: readonly {
  commands: readonly KeyboardCommandId[];
  label: string;
}[] = [
  {
    commands: ['review.file.next', 'review.file.previous'],
    label: 'next file',
  },
  {
    commands: ['review.change.next', 'review.change.previous'],
    label: 'next change',
  },
];

async function mount(labels: KeyboardShortcutLabels) {
  const { ScmComparisonRailKeys } = await import('./ScmComparisonBar');
  return renderScreen(
    <KeyboardShortcutLabelsContext.Provider value={labels}>
      <ScmComparisonRailKeys testID="keys" keys={entries} />
    </KeyboardShortcutLabelsContext.Provider>,
  );
}

describe('comparison rail key hints', () => {
    it('shows the keys the commands are bound to here', async () => {
        const screen = await mount({
            'review.file.next': 'Shift+J', 'review.file.previous': 'Shift+K',
            'review.change.next': 'J', 'review.change.previous': 'K',
        });
        expect(screen.getTextContent()).toBe('Shift J K next file J K next change');
        await screen.unmount();
    });

    it('draws no hint for keys that nothing runs (single-key shortcuts off)', async () => {
        const screen = await mount({});
        expect(screen.findHostByTestId('keys')).toBeNull();
        await screen.unmount();
    });

    it('drops only the hint whose command is unbound', async () => {
        const screen = await mount({ 'review.change.next': 'J', 'review.change.previous': 'K' });
        expect(screen.getTextContent()).toBe('J K next change');
        await screen.unmount();
    });
});
