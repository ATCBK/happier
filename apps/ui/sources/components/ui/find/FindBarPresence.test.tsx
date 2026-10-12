// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { Text, TextInput } from 'react-native';

import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';
import { FindBarPlacement, useFindBarPresence } from './FindBarPlacement';
import { FindComposerSlotHost, FindComposerSlotProvider } from './FindComposerSlot';

vi.mock('react-native', async () => await import('react-native-web'));

/** A findable surface: closing Find closes at once; the bar's last frame stays only for its exit. */
function Surface(props: Readonly<{ open: boolean; query: string }>) {
    const presence = useFindBarPresence(props.open);
    if (!presence.present) return null;
    return <FindBarPlacement testID="placement" visible={props.open}>{(presentation) =>
        <Text testID="bar">{`${presentation}:${props.query}`}</Text>}</FindBarPlacement>;
}

async function mount(width: number, ui: (open: boolean) => React.ReactElement) {
    const w = vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(width);
    const h = vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(844);
    await act(async () => { window.dispatchEvent(new Event('resize')); });
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container);
    let setOpen: (open: boolean) => void = () => {};
    function Host() { const [open, set] = React.useState(true); setOpen = set; return ui(open); }
    await act(async () => { root.render(<Host />); });
    return {
        container,
        close: async () => { await act(async () => { setOpen(false); }); },
        cleanup: async () => { await act(async () => { root.unmount(); }); container.remove(); w.mockRestore(); h.mockRestore(); await act(async () => { window.dispatchEvent(new Event('resize')); }); },
    };
}
const wait = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const leavingText = (container: HTMLElement) => {
    const hidden = container.querySelector('[aria-hidden="true"]');
    return hidden?.textContent ?? null;
};

describe('Find bar presence', () => {
    it('keeps the last open frame of the inline bar, inert, through its exit, then removes it', async () => {
        const view = await mount(1440, (open) => <Surface open={open} query={open ? 'remount' : ''} />);
        try {
            await view.close();
            // The surface already reports Find closed (empty query), but the bar leaves as it last looked.
            expect(view.container.querySelector('[data-testid="placement"]')).toBeNull();
            expect(leavingText(view.container)).toBe('inline:remount');
            await wait(400);
            expect(view.container.textContent).toBe('');
        } finally { await view.cleanup(); }
    });

    it('gives the phone composer back at once while the seated bar settles out over it', async () => {
        const view = await mount(390, (open) => <FindComposerSlotProvider>
            <Surface open={open} query={open ? 'remount' : ''} />
            <FindComposerSlotHost composer={<TextInput testID="composer" />} />
        </FindComposerSlotProvider>);
        try {
            const composer = () => view.container.querySelector<HTMLElement>('[data-testid="composer"]')!;
            const shown = (element: HTMLElement) => { for (let n: HTMLElement | null = element; n; n = n.parentElement) if (getComputedStyle(n).display === 'none') return false; return true; };
            expect(shown(composer())).toBe(false);
            await view.close();
            expect(shown(composer())).toBe(true);
            act(() => { composer().focus(); });
            expect(document.activeElement).toBe(composer());
            expect(leavingText(view.container)).toBe('keyboardSeated:remount');
            await wait(400);
            expect(leavingText(view.container)).toBeNull();
        } finally { await view.cleanup(); }
    });

    it('under reduced motion leaves with the owner short cross-fade, never a slide', async () => {
        setReducedMotionPreferenceOverride(true);
        const view = await mount(1440, (open) => <Surface open={open} query={open ? 'remount' : ''} />);
        try {
            await view.close();
            await wait(400);
            expect(view.container.textContent).toBe('');
        } finally { await view.cleanup(); setReducedMotionPreferenceOverride(null); }
    });
});
