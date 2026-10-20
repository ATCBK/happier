import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { SelectionList } from '../SelectionList';
import type { SelectionListStep } from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

// A search that finds nothing is never a dead end (FA19 W11): the step names what was searched and a
// quiet Clear empties the search in place, so the rows come back without selecting anything.
describe('SelectionList empty state for a typed search', () => {
    const step: SelectionListStep = {
        id: 'root',
        inputPlaceholder: 'Search items',
        emptyStateLabel: 'Nothing matches.',
        emptyStateForQuery: query => ({ label: `Nothing matches “${query}”`, clearLabel: 'Clear' }),
        sections: [{ kind: 'static', id: 'things', title: 'Things', options: [{ id: 'one', label: 'Launch checklist' }] }],
    };

    it('says what was searched, and Clear brings the rows back', async () => {
        const onSelect = vi.fn();
        const screen = await renderScreen(
            <SelectionList rootStep={step} onSelect={onSelect} onRequestClose={vi.fn()} disableTransitions testID="sl" />,
        );
        expect(screen.getTextContent()).toContain('Launch checklist');
        await act(async () => screen.changeTextByTestId('sl:header:input', 'kanban'));
        expect(screen.getTextContent()).toContain('Nothing matches “kanban”');
        expect(screen.getTextContent()).not.toContain('Launch checklist');
        const clear = screen.tree.findAll(node => node.props?.testID === 'sl:empty:retry' && typeof node.props.onPress === 'function')[0]!;
        await act(async () => clear.props.onPress());
        expect(screen.getTextContent()).toContain('Launch checklist');
        expect(onSelect).not.toHaveBeenCalled();
    });

    it('keeps the step\'s static sentence when nothing is typed', async () => {
        const empty: SelectionListStep = { ...step, sections: [{ kind: 'static', id: 'things', title: 'Things', options: [] }] };
        const screen = await renderScreen(
            <SelectionList rootStep={empty} onSelect={vi.fn()} onRequestClose={vi.fn()} disableTransitions testID="sl" />,
        );
        expect(screen.getTextContent()).toContain('Nothing matches.');
    });
});
