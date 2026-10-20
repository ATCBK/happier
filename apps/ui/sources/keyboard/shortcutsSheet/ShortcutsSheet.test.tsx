import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

describe('ShortcutsSheet (the ? sheet, lab KB1)', () => {
    it('lists bound commands by group and shows the other host\'s keys from its segment', async () => {
        const { ShortcutsSheet } = await import('./ShortcutsSheet');
        const screen = await renderScreen(<ShortcutsSheet onClose={vi.fn()} platform="macos" host="browser"
            singleKeyShortcutsEnabled={true} disabledCommandIds={['panes.side.toggle']} overrides={{}} />);
        expect(screen.findByTestId('shortcuts-sheet-group-panes')).not.toBeNull();
        // A command with no binding here is not a shortcut, so the sheet leaves it out.
        expect(screen.findByTestId('shortcuts-sheet-row-panes.side.toggle')).toBeNull();
        const keysOf = () => screen.findByTestId('shortcuts-sheet-row-shell.column.toggle')
            ?.findAll(node => typeof node.props.accessibilityLabel === 'string' && node.props.accessibilityLabel.includes('+'))
            .map(node => node.props.accessibilityLabel as string)[0];
        expect(keysOf()).toBe('Option+B');
        await screen.pressByTestIdAsync('shortcuts-sheet-host:desktop');
        expect(keysOf()).toBe('Cmd+B');
    });
});
