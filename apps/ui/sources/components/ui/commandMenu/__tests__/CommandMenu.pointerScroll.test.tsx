import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

import { CommandMenu } from '../CommandMenu';
import type { CommandMenuItem, CommandMenuProps } from '../commandMenuTypes';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: (key: string) => key }));

type CapturedList = { activeScrollOptionId?: string | null; rootStep: { sections: ReadonlyArray<{ options: ReadonlyArray<{ id: string; onHighlight?: () => void }> }> } };
const lists: CapturedList[] = [];
vi.mock('@/components/ui/selectionList', () => ({
    SelectionList: (props: CapturedList) => { lists.push(props); return null; },
    resolvePopoverSelectionListHeightBehavior: () => 'content',
}));
vi.mock('../CommandMenuSurface', () => ({
    CommandMenuSurface: (props: { children: React.ReactNode }) => React.createElement(React.Fragment, null, props.children),
}));

const items: readonly CommandMenuItem[] = ['one', 'two', 'three'].map((id) => ({ id, label: id, onHighlight: () => {} }));
const menu = (selectedIndex: number): CommandMenuProps => ({
    open: true, anchor: { kind: 'rect', rect: { left: 0, top: 0, width: 1, height: 1 } }, query: '', items, selectedIndex,
    onMoveUp: () => {}, onMoveDown: () => {}, onSelect: () => {}, onRequestClose: () => {},
});
const last = () => lists[lists.length - 1]!;

describe('a command menu list scrolls to the keyboard selection, never to the pointer', () => {
    it('keeps the opening scroll target when the pointer highlights a lower row, and follows the keyboard again afterwards', async () => {
        const screen = await renderScreen(<CommandMenu {...menu(0)} />);
        expect(last().activeScrollOptionId).toBe('one');
        // The pointer resting on a row near the bottom highlights it; the list must not scroll to it.
        last().rootStep.sections[0]!.options[2]!.onHighlight?.();
        await screen.update(<CommandMenu {...menu(2)} />);
        expect(last().activeScrollOptionId).toBe('one');
        // An arrow key moves the selection: the list follows it.
        await screen.update(<CommandMenu {...menu(1)} />);
        expect(last().activeScrollOptionId).toBe('two');
    });
});
