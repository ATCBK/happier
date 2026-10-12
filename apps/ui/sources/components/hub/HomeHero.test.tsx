import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import type { View } from 'react-native';
import { renderHook } from '@/dev/testkit';
import { useHomeHeroFrame } from './HomeHero';

describe('Home atmosphere geometry while the composer is focused', () => {
    it('holds a prefilled draft through shrink and growth, updates on resize, then catches up on blur', async () => {
        const hook = await renderHook(() => useHomeHeroFrame({ active: true, focused: true, phone: true }));
        let paneHeight = 844;
        let composerHeight = 180;
        let composerTop = 300;
        const frame = hook.getCurrent();
        // Native measurement is the external boundary; the hook's geometry and store stay real.
        const node = (box: () => { x: number; y: number; width: number; height: number }) => ({
            measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => {
                const value = box(); done(value.x, value.y, value.width, value.height);
            },
        }) as View;
        frame.paneRef.current = node(() => ({ x: 0, y: 0, width: 390, height: paneHeight }));
        frame.headlineRef.current = node(() => ({ x: 0, y: 200, width: 390, height: 40 }));
        frame.composerRef.current = node(() => ({ x: 16, y: composerTop, width: 358, height: composerHeight }));
        frame.suggestionsRef.current = node(() => ({ x: 16, y: composerTop + composerHeight + 12, width: 358, height: 32 }));
        frame.nextRef.current = node(() => ({ x: 16, y: composerTop + composerHeight + 100, width: 358, height: 80 }));
        const measure = async () => act(async () => { hook.getCurrent().measure(); });
        await measure();
        const before = hook.getCurrent().hero;
        await act(async () => { hook.getCurrent().onComposerFocus(); });
        composerHeight = 70;
        composerTop = 285;
        await measure();
        expect(hook.getCurrent().hero).toEqual(before);
        composerHeight = 230;
        await measure();
        expect(hook.getCurrent().hero).toEqual(before);
        paneHeight = 600;
        await measure();
        expect(hook.getCurrent().hero?.aboveBottom).toBe(559);
        composerHeight = 90;
        await measure();
        expect(hook.getCurrent().hero?.aboveBottom).toBe(559);
        await act(async () => { hook.getCurrent().onComposerBlur(); });
        expect(hook.getCurrent().hero?.aboveBottom).toBe(419);
        await hook.unmount();
    });
});
