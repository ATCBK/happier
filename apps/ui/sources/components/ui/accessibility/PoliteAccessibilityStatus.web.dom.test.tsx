/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A live region announces DOM mutations, so this must render through RNW's real
// host primitives: a test-renderer prop bag cannot show which text node a screen
// reader would observe being inserted.
vi.mock('react-native', async () => await vi.importActual('react-native-web'));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

const STATUS_TEST_ID = 'operation-a11y-status';

// Module scope: collection has no hook timeout for the cold RNW module graph.
const { PoliteAccessibilityStatus } = await import('./PoliteAccessibilityStatus');

let container: HTMLElement | null = null;
let root: Root | null = null;

afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
});

async function render(announcement: string, transitionKey: string): Promise<void> {
    if (!container) {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    }
    await act(async () => {
        root!.render(
            <PoliteAccessibilityStatus
                announcement={announcement}
                statusTestID={STATUS_TEST_ID}
                transitionKey={transitionKey}
            />,
        );
    });
}

function region(): HTMLElement {
    const node = container?.querySelector<HTMLElement>(`[data-testid="${STATUS_TEST_ID}"]`);
    if (!node) throw new Error('live region was not rendered');
    return node;
}

function spokenNode(): Element | null {
    return region().firstElementChild;
}

describe('PoliteAccessibilityStatus on web', () => {
    it('inserts the state it mounts with together with the region, never as a later change', async () => {
        await render('Home data deleted.', 'erase:completed');
        const mounted = spokenNode();

        // Present from insertion (discoverable, not a live change), and a
        // re-render under the same transition does not mutate it into news.
        expect(region().getAttribute('aria-live')).toBe('polite');
        expect(mounted?.textContent).toBe('Home data deleted.');
        await render('Home data deleted.', 'erase:completed');
        expect(spokenNode()).toBe(mounted);
    });

    it('inserts a fresh text node when an identical message arrives under a new transition', async () => {
        await render('', 'idle');
        await render('Approved: Home A', 'revision:1');
        const first = spokenNode();
        expect(first?.textContent).toBe('Approved: Home A');

        await render('Approved: Home A', 'revision:2');

        // Screen readers announce inserted content; an untouched node stays silent.
        expect(spokenNode()?.textContent).toBe('Approved: Home A');
        expect(spokenNode()).not.toBe(first);
        const liveRegion = region();
        await render('', 'revision:2:acknowledged');
        expect(region()).toBe(liveRegion);
        expect(region().textContent).toBe('');
    });

    it('coalesces new text that arrives under the same transition', async () => {
        await render('', 'idle');
        await render('Ana is viewing', 'members:ana');
        const spoken = spokenNode();

        await render('Ana is typing', 'members:ana');

        expect(spokenNode()).toBe(spoken);
        expect(region().textContent).toBe('Ana is viewing');
    });

    it('stays out of pointer and layout flow without the deprecated RNW pointerEvents prop', async () => {
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            await render('', 'idle');
            await render('Saved', 'saved');

            const style = getComputedStyle(region());
            expect(style.pointerEvents).toBe('none');
            expect(style.position).toBe('absolute');
            expect(warning.mock.calls.filter(([message]) => (
                String(message).includes('props.pointerEvents is deprecated')
            ))).toEqual([]);
        } finally {
            warning.mockRestore();
        }
    });
});
