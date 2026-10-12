// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { Text } from 'react-native';

import { FindBarPlacement } from './FindBarPlacement';
import { FindComposerSlotHost, FindComposerSlotProvider } from './FindComposerSlot';

// The real RNW host, so `display: none` and layout reach the DOM.
vi.mock('react-native', async () => await import('react-native-web'));

describe('phone Find takes the composer slot', () => {
    it('seats the phone Find bar in place of the composer and gives the composer back, draft intact, on Done', async () => {
        const width = vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(390);
        const height = vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(844);
        await act(async () => { window.dispatchEvent(new Event('resize')); });
        const container = document.createElement('div'); document.body.appendChild(container);
        const root = createRoot(container);
        let setOpen: (open: boolean) => void = () => {};
        let composerMounts = 0;
        function Composer() {
            React.useEffect(() => { composerMounts += 1; }, []);
            return <Text testID="composer">draft</Text>;
        }
        function Screen() {
            const [open, setOpenState] = React.useState(false);
            setOpen = setOpenState;
            return <FindComposerSlotProvider>
                <Text>transcript</Text>
                {open ? <FindBarPlacement testID="seat">{(presentation) => <Text testID="bar">{presentation}</Text>}</FindBarPlacement> : null}
                <FindComposerSlotHost composer={<Composer />} />
            </FindComposerSlotProvider>;
        }
        const visible = (id: string) => {
            const el = container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
            if (!el) return false;
            for (let node: HTMLElement | null = el; node; node = node.parentElement) if (getComputedStyle(node).display === 'none') return false;
            return true;
        };
        try {
            await act(async () => { root.render(<Screen />); });
            expect(visible('composer')).toBe(true);
            await act(async () => { setOpen(true); });
            // The bar is seated where the composer was: the slot shows it and the composer is out of view.
            const bar = container.querySelector('[data-testid="bar"]');
            expect(bar?.textContent).toBe('keyboardSeated');
            expect(bar?.closest('[data-testid="find-composer-slot"]')).not.toBeNull();
            expect(visible('composer')).toBe(false);
            await act(async () => { setOpen(false); });
            expect(container.querySelector('[data-testid="bar"]')).toBeNull();
            expect(visible('composer')).toBe(true);
            // Hidden, never unmounted: the draft survives Find.
            expect(composerMounts).toBe(1);
        } finally {
            await act(async () => { root.unmount(); }); container.remove(); width.mockRestore(); height.mockRestore();
            await act(async () => { window.dispatchEvent(new Event('resize')); });
        }
    });
});
