import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act } from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';

const capturedChrome = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));
const capturedControllerProps = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));

vi.mock('@/modal/components/card/useModalCardChrome', () => ({
    useModalCardChrome: (_setChrome: unknown, chrome: Record<string, unknown>) => {
        capturedChrome.value = chrome;
    },
}));

vi.mock('./UniversalSearchController', () => ({
    UniversalSearchController: (props: Record<string, unknown>) => {
        capturedControllerProps.value = props;
        return React.createElement('UniversalSearchController', props);
    },
}));

afterEach(() => {
    capturedChrome.value = null;
    capturedControllerProps.value = null;
    standardCleanup();
});

describe('UniversalSearchModal', () => {
    it('uses the bounded card seam while leaving SelectionList as the sole scroll owner', async () => {
        const { UniversalSearchModal } = await import('./UniversalSearchModal');

        await renderScreen(
            <UniversalSearchModal
                commands={[]}
                onClose={vi.fn()}
                setChrome={vi.fn()}
            />,
        );

        expect(capturedChrome.value).toEqual(expect.objectContaining({
            header: 'none',
            title: 'Search',
            scrollHost: 'body',
            bodyScroll: 'none',
            dimensions: { width: 640, maxHeightRatio: 0.7, size: 'lg' },
            // A phone-width window is a phone: Search fills it (lab G1sp), never a floating card.
            phonePresentation: 'fullscreen',
        }));
    });

    // Lab G1 / G1s: Everything is a compact palette; Text in files (and the conversation results) widen it
    // for the detail column beside the list.
    it('widens the card while the controller shows a detail mode and narrows it again', async () => {
        const { UniversalSearchModal } = await import('./UniversalSearchModal');
        await renderScreen(<UniversalSearchModal commands={[]} onClose={vi.fn()} setChrome={vi.fn()} />);
        const setLayout = capturedControllerProps.value?.onSurfaceLayoutChange as ((layout: 'compact' | 'detail') => void) | undefined;
        expect(setLayout).toBeTypeOf('function');
        await act(async () => { setLayout!('detail'); });
        expect((capturedChrome.value?.dimensions as { width: number }).width).toBe(960);
        await act(async () => { setLayout!('compact'); });
        expect((capturedChrome.value?.dimensions as { width: number }).width).toBe(640);
    });
});
