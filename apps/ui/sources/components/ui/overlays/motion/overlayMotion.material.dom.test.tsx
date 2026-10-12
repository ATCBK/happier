/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { GlassMaterialSettingsProvider } from '@/components/ui/glass/useGlassMaterialSettings';
import { glassPresetMaterials } from '@/components/ui/glass/glassMaterial';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { OverlayMotionFrame } from './overlayMotion';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    setReducedMotionPreferenceOverride(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('web overlay material composition', () => {
    it('moves backdrop paint with its content by transform, never opacity, while its ancestors stay still', async () => {
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        // Hold the browser's clock at the first animation frame, before the enter settles.
        vi.useFakeTimers();
        const runs: { target: HTMLElement; frames: Keyframe[]; options: KeyframeAnimationOptions; cancel: ReturnType<typeof vi.fn> }[] = [];
        // WAAPI is the browser boundary; the frame, material policy and RNW layout stay real.
        const animate = vi.fn(function (this: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
            const cancel = vi.fn();
            runs.push({ target: this, frames, options, cancel });
            return { playState: 'running', effect: { target: this }, cancel } as unknown as Animation;
        });
        Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
        function Scene({ visible, preset }: { visible: boolean; preset: 'auto' | 'solid' }) {
            return <GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials(preset) }}>
                <OverlayMotionFrame visible={visible} kind="popover" direction="bottom">
                    <GlassSurface testID="material" finishRole={null} style={{ padding: 12, gap: 8, alignItems: 'stretch' }}>
                        <input data-testid="draft" defaultValue="keep this draft" />
                        <button>Continue</button>
                        <GlassSurface finishRole={null}><button>Nested action</button></GlassSurface>
                    </GlassSurface>
                </OverlayMotionFrame>
            </GlassMaterialSettingsProvider>;
        }
        try {
            await act(async () => root.render(<Scene visible preset="auto" />));
            const material = container.querySelector<HTMLElement>('[data-testid="material"]')!;
            const paint = Array.from(material.children).find(child => (child as HTMLElement).style.backdropFilter.includes('blur')) as HTMLElement;
            expect(paint).toBeTruthy();
            for (let ancestor = paint.parentElement; ancestor && ancestor !== container; ancestor = ancestor.parentElement) {
                expect(getComputedStyle(ancestor).opacity || '1').toBe('1');
                expect(getComputedStyle(ancestor).transform || 'none').toBe('none');
            }
            const input = container.querySelector<HTMLInputElement>('[data-testid="draft"]')!;
            expect(runs.some(run => run.target === input)).toBe(true);
            // A frame with material paint scales and translates as a whole; content that faded over solid paper would show an empty card.
            for (const run of runs.filter(entry => entry.target === input)) {
                for (const frame of run.frames) expect(frame).toMatchObject({ opacity: '1' });
            }
            const backdrops = Array.from(material.querySelectorAll<HTMLElement>('[data-happy-glass-backdrop]'));
            expect(backdrops).toHaveLength(2);
            for (const backdrop of backdrops) {
                // Opacity under an ancestor or on the paint would empty the blur's backdrop; transform keeps it sampling the page.
                const enter = runs.filter(run => run.target === backdrop);
                expect(enter).toHaveLength(1);
                expect(enter[0]!.frames[0]).toHaveProperty('transform', 'translate(0px, -8px) scale(0.98)');
                for (const frame of enter[0]!.frames) expect(frame).not.toHaveProperty('opacity');
                expect(runs.some(run => run.target !== backdrop && run.target.contains(backdrop))).toBe(false);
            }
            expect(material.style.padding).toBe('12px');
            expect(material.style.gap).toBe('8px');
            input.style.opacity = '0.4';
            input.style.transform = 'translateY(2px)';
            await act(async () => root.render(<Scene visible={false} preset="auto" />));
            const exit = runs.filter(run => run.target === input).at(-1)!;
            expect(exit.frames[0]).toMatchObject({ opacity: '0.4', transform: 'translateY(2px)' });
            expect(exit.frames[1]).toMatchObject({ opacity: '1' });
            expect(exit.options.duration).toBe(motionTokens.overlay.popover.exitMs);
            expect(exit.options.fill).toBeUndefined();
            expect(material.parentElement?.style.pointerEvents).toBe('none');
            const paintExit = runs.filter(run => run.target === paint).at(-1)!;
            expect(paintExit.frames[1]).toHaveProperty('transform', 'translate(0px, -8px) scale(0.98)');
            expect(paintExit.frames[1]).not.toHaveProperty('opacity');
            expect(paint.style.opacity).toBe('');
            await act(async () => root.render(<Scene visible preset="solid" />));
            expect(container.querySelector('[data-testid="draft"]')).toBe(input);
            expect(input.value).toBe('keep this draft');
            expect(input.style.opacity).toBe('');
            expect(input.style.transform).toBe('');
            await act(async () => root.render(<Scene visible preset="auto" />));
            expect(container.querySelector('[data-testid="draft"]')).toBe(input);
        } finally {
            await act(async () => root.unmount());
            expect(runs.every(run => run.cancel.mock.calls.length > 0)).toBe(true);
            delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
            container.remove();
        }
    });
    it('rises a bottom sheet by its own height, paper and content together, and changes at once under reduced motion', async () => {
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        const runs: { target: HTMLElement; frames: Keyframe[]; options: KeyframeAnimationOptions }[] = [];
        Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: function (this: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
            runs.push({ target: this, frames, options });
            return { playState: 'finished', cancel: () => {} } as unknown as Animation;
        } });
        // jsdom has no layout: report the frame's height the way a browser would.
        const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 320 } as DOMRect);
        function Sheet() {
            return <GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('auto') }}>
                <OverlayMotionFrame visible kind="modal" direction="bottom">
                    <GlassSurface testID="sheet" finishRole={null}><button>Hold</button></GlassSurface>
                </OverlayMotionFrame>
            </GlassMaterialSettingsProvider>;
        }
        try {
            await act(async () => root.render(<Sheet />));
            const backdrop = container.querySelector<HTMLElement>('[data-happy-glass-backdrop]')!;
            const button = container.querySelector('button')!;
            for (const target of [backdrop, button]) {
                const run = runs.find(entry => entry.target === target)!;
                expect(run.frames[0]).toMatchObject({ transform: 'translate(0px, 320px) scale(1)' });
                expect(run.options.duration).toBe(motionTokens.overlay.modal.enterMs);
            }
            // The sheet is not see-through on the way up.
            expect(runs.find(entry => entry.target === button)!.frames[0]).toMatchObject({ opacity: '1' });
            runs.length = 0;
            await act(async () => setReducedMotionPreferenceOverride(true));
            // Fading content over still paper would show an empty card, so a material frame changes at once.
            expect(runs).toEqual([]);
        } finally {
            rect.mockRestore();
            await act(async () => root.unmount());
            delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
            container.remove();
        }
    });
    it('keeps plain popovers animated and honors reduced motion without leaving a transform after opening', async () => {
        const container = document.createElement('div');
        const root = createRoot(container);
        const runs: { target: HTMLElement; frames: Keyframe[]; options: KeyframeAnimationOptions }[] = [];
        Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: function (this: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
            runs.push({ target: this, frames, options });
            return { playState: 'finished', cancel: () => {} } as unknown as Animation;
        } });
        try {
            await act(async () => root.render(<OverlayMotionFrame visible kind="popover" direction="bottom"><button>Plain action</button></OverlayMotionFrame>));
            expect(runs).toHaveLength(1);
            expect(runs[0]!.target.contains(container.querySelector('button'))).toBe(true);
            expect(runs[0]!.frames[0]).toMatchObject({ opacity: '0', transform: 'translate(0px, -8px) scale(0.98)' });
            expect(runs[0]!.target.style.transform).toBe('');
            await act(async () => setReducedMotionPreferenceOverride(true));
            const reduced = runs.at(-1)!;
            expect(reduced.options.duration).toBe(motionTokens.durationMs.fast);
            expect(reduced.frames).toEqual([{ opacity: '0', transform: 'none' }, { opacity: '1', transform: 'none' }]);
        } finally {
            await act(async () => root.unmount());
            delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
        }
    });
});
