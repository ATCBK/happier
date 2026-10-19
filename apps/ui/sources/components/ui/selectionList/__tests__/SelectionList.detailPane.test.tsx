import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen, findAllHostTestInstances } from '@/dev/testkit';

import { SelectionList } from '../SelectionList';
import { SelectionListDetailPaneContext } from '../SelectionListDetailPaneContext';
import type { SelectionListProps } from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

function RowLine(props: Readonly<{ text: string }>) {
    // A row reads whether its detail is shown beside the list, so it can keep itself to one line there.
    const inPane = React.useContext(SelectionListDetailPaneContext);
    return React.createElement('RowLine', { text: props.text, inPane });
}

function props(): SelectionListProps {
    return {
        rootStep: { id: 'root', inputPlaceholder: 'Search', sections: [{ kind: 'static', id: 'hits', options: [
            { id: 'a', label: 'a.ts:4', labelContent: () => <RowLine text="a" />, detailContent: () => React.createElement('Detail', { testID: 'detail-a' }) },
            { id: 'b', label: 'b.ts:9', detailContent: () => React.createElement('Detail', { testID: 'detail-b' }) },
        ] }] },
        onSelect: vi.fn(),
        onRequestClose: vi.fn(),
        keyboardHintsEnabled: false,
        disableTransitions: true,
        detailPane: { minListWidthPx: 700, widthPx: 360 },
        testID: 'sl',
    };
}

async function layout(screen: Awaited<ReturnType<typeof renderScreen>>, width: number) {
    await act(async () => {
        screen.findByTestId('sl')?.props.onLayout?.({ nativeEvent: { layout: { width, height: 600, x: 0, y: 0 } } });
    });
}

// Lab G1s: on a wide card the active row's detail sits beside the list; narrower, rows carry it themselves.
describe('SelectionList detail pane', () => {
    it('shows the active row\'s detail beside the list only when the list is wide enough', async () => {
        const screen = await renderScreen(<SelectionList {...props()} />);
        await layout(screen, 1000);
        expect(screen.findByTestId('detail-a')).not.toBeNull();
        expect(screen.findByTestId('detail-b')).toBeNull();
        expect(findAllHostTestInstances(screen.root, (node) => node.type === 'RowLine')[0]?.props.inPane).toBe(true);

        await layout(screen, 500);
        expect(screen.findByTestId('detail-a')).toBeNull();
        expect(findAllHostTestInstances(screen.root, (node) => node.type === 'RowLine')[0]?.props.inPane).toBe(false);
    });
});
