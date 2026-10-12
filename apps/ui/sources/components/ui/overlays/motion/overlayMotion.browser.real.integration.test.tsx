/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { chromium, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

import { Text, View } from 'react-native';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { GlassMaterialSettingsProvider } from '@/components/ui/glass/useGlassMaterialSettings';
import { glassPresetMaterials } from '@/components/ui/glass/glassMaterial';
import { resolveChromiumExecutable } from '@/dev/testkit/render/measureWebLayout';
import { OverlayMotionFrame, type OverlayMotionDirection, type OverlayMotionKind } from './overlayMotion';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The hook's real keyframes, replayed on the real DOM in real Chromium. jsdom renders the overlay (react-native-web,
 * the glass paint and the motion owner); Chromium has the layout, the compositor and the backdrop blur. Each Web
 * Animation the owner starts is recorded, replayed paused on the matching element, and stepped through its progress,
 * so every frame is deterministic. Capture-only: the contract has its own DOM test.
 */
const capture = process.env.OVERLAY_MOTION_CAPTURE_DIR;
const steps = [0, 0.25, 0.5, 0.75, 1];
const stripes = 'repeating-linear-gradient(90deg, #d9534f 0 14px, #f7f3ea 14px 28px, #4a6fa5 28px 42px)';

type Run = { id: number; paint: boolean; frames: Keyframe[]; duration: number; easing: string };
type Scene = { kind: OverlayMotionKind; direction?: OverlayMotionDirection; layout: 'bottom' | 'center' | 'popover'; width: number; height: number };

afterEach(() => { document.body.replaceChildren(); delete (HTMLElement.prototype as Partial<HTMLElement>).animate; vi.restoreAllMocks(); });

function Overlay({ scene }: { scene: Scene }) {
    const place = scene.layout === 'bottom'
        ? { justifyContent: 'flex-end' as const, alignItems: 'stretch' as const }
        : scene.layout === 'center' ? { justifyContent: 'center' as const, alignItems: 'center' as const }
            : { justifyContent: 'flex-start' as const, alignItems: 'flex-start' as const, paddingTop: 170, paddingLeft: 40 };
    return <GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('auto') }}>
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, ...place }} pointerEvents="box-none">
            <OverlayMotionFrame visible kind={scene.kind} direction={scene.direction}>
                <GlassSurface finishRole={null} style={{ padding: 20, gap: 12, width: scene.layout === 'bottom' ? undefined : 320, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderRadius: scene.layout === 'bottom' ? undefined : 20 }}>
                    <Text style={{ fontSize: 17, fontWeight: '600' }}>Review the changelog draft</Text>
                    <Text style={{ fontSize: 15 }}>Approve the draft, or send it back with a note. The Run keeps waiting until you answer.</Text>
                    <View style={{ height: 44, backgroundColor: '#2f7d4f', borderRadius: 12 }} />
                </GlassSurface>
            </OverlayMotionFrame>
        </View>
    </GlassMaterialSettingsProvider>;
}

async function renderScene(scene: Scene, frameHeight: number) {
    const container = document.createElement('div');
    document.body.append(container);
    const runs: Run[] = [];
    let counter = 0;
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: function (this: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
        const id = counter++;
        this.setAttribute('data-motion-target', String(id));
        runs.push({ id, paint: this.hasAttribute('data-happy-glass-backdrop'), frames, duration: Number(options.duration), easing: String(options.easing) });
        return { playState: 'finished', cancel: () => {} } as unknown as Animation;
    } });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: frameHeight } as DOMRect);
    const root = createRoot(container);
    await act(async () => root.render(<Overlay scene={scene} />));
    const styles = Array.from(document.querySelectorAll('style')).map(element => {
        const rules = element.sheet?.cssRules;
        return rules && rules.length > 0 ? Array.from(rules).map(rule => rule.cssText).join('\n') : element.textContent ?? '';
    }).join('\n');
    const html = container.innerHTML;
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
    const page = `<!doctype html><html><head><meta charset="utf-8"><style>${styles}</style><style>html,body{margin:0;height:100%;overflow:hidden;font-family:Inter,Arial,sans-serif}</style></head>`
        + `<body><div style="position:fixed;inset:0;background:${stripes}"></div><div id="root" style="position:fixed;inset:0;display:flex;flex-direction:column">${html}</div></body></html>`;
    return { page, runs };
}

async function frameHeightIn(page: Page): Promise<number> {
    return page.evaluate(() => {
        const paint = document.querySelector('[data-happy-glass-backdrop]') as HTMLElement | null;
        let frame = paint?.parentElement ?? null;
        // The motion frame is the nearest ancestor that is not the glass surface itself.
        frame = frame?.parentElement ?? null;
        return frame ? frame.getBoundingClientRect().height : 0;
    });
}

describe.skipIf(!capture)('overlay motion frames on a real browser', () => {
    const cases: Array<[string, Scene]> = [
        ['sheet-390', { kind: 'modal', direction: 'bottom', layout: 'bottom', width: 390, height: 800 }],
        ['centered-1440', { kind: 'modal', layout: 'center', width: 1440, height: 900 }],
        ['popover-1440', { kind: 'popover', direction: 'bottom', layout: 'popover', width: 1440, height: 900 }],
    ];
    for (const [name, scene] of cases) {
        it(`steps the ${name} enter`, async () => {
            await mkdir(capture!, { recursive: true });
            const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
            try {
                const page = await browser.newPage({ viewport: { width: scene.width, height: scene.height } });
                // Pass 1 measures the real frame; pass 2 feeds that height to the owner, as the browser would.
                const first = await renderScene(scene, 320);
                await page.setContent(first.page);
                const measured = Math.round(await frameHeightIn(page));
                const { page: html, runs } = await renderScene(scene, measured);
                await page.setContent(html);
                expect(runs.some(run => run.paint), `${name} moves its paint`).toBe(true);
                expect(runs.filter(run => run.paint).every(run => run.frames.every(frame => !('opacity' in frame)))).toBe(true);
                await page.evaluate(entries => {
                    const animations = entries.map(run => {
                        const element = document.querySelector(`[data-motion-target="${run.id}"]`) as HTMLElement;
                        const animation = element.animate(run.frames, { duration: run.duration, easing: run.easing });
                        animation.pause();
                        return animation;
                    });
                    (window as unknown as { motionAnimations: Animation[] }).motionAnimations = animations;
                }, runs);
                for (const step of steps) {
                    await page.evaluate(({ step, runs }) => {
                        const animations = (window as unknown as { motionAnimations: Animation[] }).motionAnimations;
                        animations.forEach((animation, index) => { animation.currentTime = step * runs[index]!.duration; });
                    }, { step, runs });
                    await page.screenshot({ path: join(capture!, `${name}-enter-${Math.round(step * 100)}.png`) });
                }
            } finally { await browser.close(); }
        }, 120_000);
    }
});
