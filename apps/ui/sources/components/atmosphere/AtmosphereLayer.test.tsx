import 'fake-indexeddb/auto';
import * as React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_HOME_ATMOSPHERE } from '@happier-dev/protocol/account/settings/accountSettings';
import { flattenTestStyle, renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { AtmosphereLayer } from './AtmosphereLayer';
import { atmosphereStageStore } from './atmosphereStage';
import { pictureStore } from './pictureStore';
import type { BackdropWorkerRequest, BackdropWorkerResponse } from './backdropCanvas.types';
import { GlassAtmosphereBehindSetterProvider, GlassAtmosphereToneSetterProvider, GlassRuntimeEnvironmentProvider, useGlassRuntimeEnvironment } from '@/components/ui/glass/glassRuntimeEnvironment';
import { resolveGlassSurfacePlaneMaterial } from '@/components/ui/glass/glassSurfacePaint';
import { useGlassMaterialSettings } from '@/components/ui/glass/useGlassMaterialSettings';
import type { GlassAtmosphereTone, GlassMaterialEnvironment } from '@/components/ui/glass/glassMaterial';

// Exercise the real browser drawing and device-storage adapters under their OS boundaries.
vi.mock('./BackdropCanvas', async () => import('./BackdropCanvas.web'));
vi.mock('./WallpaperHaze', async () => import('./WallpaperHaze.web'));
vi.mock('./pictureStore', async () => import('./pictureStore.web'));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

afterEach(() => { atmosphereStageStore.clearStage(-1); atmosphereStageStore.clearStage(-2); vi.unstubAllGlobals(); });

function picturePosition(node: ReactTestInstance) {
    let x = 0, y = 0;
    for (let current: ReactTestInstance | null = node; current; current = current.parent) {
        if (typeof current.type !== 'string') continue;
        const style = flattenTestStyle(current.props.style);
        x += Number(style.left ?? 0) + Number(style.marginLeft ?? 0);
        y += Number(style.top ?? 0) + Number(style.marginTop ?? 0);
        if (Array.isArray(style.transform)) for (const transform of style.transform) {
            y += Number(transform.translateY ?? 0);
        }
    }
    return { x, y };
}

it('clears the content plane for the Planet under Solid and restores it when the background is removed', async () => {
    const previous = storage.getState();
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    function PaintProbe() {
        const environment = useGlassRuntimeEnvironment();
        const settings = useGlassMaterialSettings();
        const material = resolveGlassSurfacePlaneMaterial(settings, 'content', environment);
        return React.createElement('PaintProbe', { testID: 'atmosphere-content-paint', material });
    }
    function Shell() {
        const [atmosphereBehind, setBehind] = React.useState<NonNullable<GlassMaterialEnvironment['atmosphereBehind']>>('none');
        return <GlassRuntimeEnvironmentProvider value={{ atmosphereBehind }}>
            <GlassAtmosphereBehindSetterProvider value={setBehind}>
                <AtmosphereLayer sheetRadius={12} chrome={false} />
                <PaintProbe />
            </GlassAtmosphereBehindSetterProvider>
        </GlassRuntimeEnvironmentProvider>;
    }
    try {
        storage.setState(state => ({ ...state, settings: { ...state.settings,
            glassBlurEnabled: false, homeAtmosphere: DEFAULT_HOME_ATMOSPHERE,
        } }));
        atmosphereStageStore.setStage({ id: -1, surface: 'home', geometry: {
            rect: { x: 0, y: 0, width: 800, height: 600 }, band: 350, horizonAt: 0.86, focus: { x: 400, y: 250 },
        } }, true);
        screen = await renderScreen(<Shell />, { createNodeMock: () => ({
            measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => done(0, 0, 800, 600),
        }) });
        expect(screen.findHostByTestId('atmosphere-content-paint')!.props.material).toEqual({ blur: 'off', opacity: 0 });
        await act(async () => storage.setState(state => ({ ...state, settings: { ...state.settings,
            homeAtmosphere: { ...DEFAULT_HOME_ATMOSPHERE, source: 'none' },
        } })));
        expect(screen.findHostByTestId('atmosphere-content-paint')!.props.material).toEqual({ blur: 'off', opacity: 1 });
    } finally {
        await screen?.unmount();
        await act(async () => storage.setState(previous, true));
    }
});

it('projects one continuous picture in a scrolling Home beside stationary Project tabs across focus changes', async () => {
    let jobs = 0;
    vi.stubGlobal('Worker', class {
        onmessage: ((event: { data: BackdropWorkerResponse }) => void) | null = null;
        postMessage(message: BackdropWorkerRequest) {
            if (!('request' in message)) return;
            jobs++;
            const { width: w, height: h } = message.request;
            queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ok: true,
                result: { rgba: new Uint8ClampedArray(w * h * 4), w, h } } }));
        }
        terminate() {}
    });
    vi.stubGlobal('ImageData', class {
        constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    });
    const previous = storage.getState();
    const localId = 'split-scroll-test';
    await pictureStore.put({ localId, kind: 'user', data: new Blob(['prepared picture'], { type: 'image/webp' }) });
    const home = { id: -1, surface: 'home' as const, geometry: {
        rect: { x: 0, y: 0, width: 500, height: 600 }, band: 350, horizonAt: 0.86, focus: { x: 250, y: 250 },
    } };
    const project = { id: -2, surface: { project: { serverId: 'home-a', projectKey: 'project-a' } }, geometry: {
        rect: { x: 508, y: 0, width: 500, height: 600 }, band: 110, horizonAt: 0.86, focus: { x: 250, y: 55 },
    } };
    try {
        storage.setState(state => ({ ...state, settings: { ...state.settings, homeAtmosphere: {
            ...DEFAULT_HOME_ATMOSPHERE, source: 'picture', picture: { ref: { kind: 'user', localId }, layout: 'horizon' },
        } } }));
        atmosphereStageStore.setStage(home, true);
        atmosphereStageStore.setStage(project, false);
        const screen = await renderScreen(<AtmosphereLayer sheetRadius={12} chrome={false} />, { createNodeMock: element =>
            element.type === 'canvas' ? { getContext: () => ({ putImageData() {} }) } : {
                measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => done(0, 0, 1008, 600),
            },
        });
        const positions = () => screen.findAllHostsByTestId('atmosphere-band').map(picturePosition);
        expect(positions()).toEqual([{ x: 0, y: 0 }, { x: 0, y: 0 }]);
        await act(async () => atmosphereStageStore.setScrollY(home.id, 137));
        expect(positions()).toEqual([{ x: 0, y: -137 }, { x: 0, y: 0 }]);
        await act(async () => {
            atmosphereStageStore.setStage(home, false);
            atmosphereStageStore.setStage(project, true);
        });
        expect(positions()).toEqual([{ x: 0, y: -137 }, { x: 0, y: 0 }]);
        await act(async () => {
            atmosphereStageStore.setStage(project, false);
            atmosphereStageStore.setStage(home, true);
        });
        expect(positions()).toEqual([{ x: 0, y: -137 }, { x: 0, y: 0 }]);
        expect(jobs).toBe(1);
        await act(async () => storage.setState(state => ({ ...state, settings: { ...state.settings,
            glassBlurEnabled: false, homeAtmosphere: { ...state.settings.homeAtmosphere,
                picture: { ...state.settings.homeAtmosphere.picture, layout: 'wallpaper' },
            },
        } })));
        expect(screen.findHostByTestId('atmosphere-wallpaper')).not.toBeNull();
        expect(screen.findAllHostsByTestId('atmosphere-band')).toHaveLength(0);
        await screen.unmount();
    } finally {
        storage.setState(previous, true);
        await pictureStore.remove(localId);
    }
});

it('measures the tone again where the content settles, without waiting for another render of the picture', async () => {
    let jobs = 0;
    // A picture dark at the top and light at the bottom: where the head lines stand decides their tone.
    vi.stubGlobal('Worker', class {
        onmessage: ((event: { data: BackdropWorkerResponse }) => void) | null = null;
        postMessage(message: BackdropWorkerRequest) {
            if (!('request' in message)) return;
            jobs++;
            const { width: w, height: h } = message.request;
            const rgba = new Uint8ClampedArray(w * h * 4);
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
                const at = (y * w + x) * 4;
                rgba[at] = rgba[at + 1] = rgba[at + 2] = Math.round((y / (h - 1)) * 255);
                rgba[at + 3] = 255;
            }
            queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ok: true, result: { rgba, w, h } } }));
        }
        terminate() {}
    });
    vi.stubGlobal('ImageData', class {
        constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    });
    const previous = storage.getState();
    const localId = 'settling-geometry-test';
    await pictureStore.put({ localId, kind: 'user', data: new Blob(['prepared picture'], { type: 'image/webp' }) });
    const rect = { x: 0, y: 0, width: 800, height: 600 };
    const tones: (GlassAtmosphereTone | undefined)[] = [];
    try {
        storage.setState(state => ({ ...state, settings: { ...state.settings, homeAtmosphere: {
            ...DEFAULT_HOME_ATMOSPHERE, source: 'picture', picture: { ref: { kind: 'user', localId }, layout: 'wallpaper' },
        } } }));
        // Home first lays out with its head lines high on the page, then settles them lower.
        atmosphereStageStore.setStage({ id: -1, surface: 'home', geometry: { rect, band: 350, horizonAt: 0.86, focus: { x: 400, y: 60 } } }, true);
        const screen = await renderScreen(<GlassAtmosphereToneSetterProvider value={tone => { tones.push(tone); }}>
            <AtmosphereLayer sheetRadius={12} chrome={false} />
        </GlassAtmosphereToneSetterProvider>, { createNodeMock: element =>
            element.type === 'canvas' ? { getContext: () => ({ putImageData() {} }) } : {
                measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => done(0, 0, 800, 600),
            },
        });
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
        const early = tones.at(-1);
        expect(early?.focus).toBeLessThan(0.1);
        const rendered = jobs;
        await act(async () => atmosphereStageStore.setStage({ id: -1, surface: 'home', geometry: { rect, band: 350, horizonAt: 0.86, focus: { x: 400, y: 520 } } }, true));
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
        expect(jobs).toBe(rendered);
        expect(tones.at(-1)?.focus).toBeGreaterThan(0.5);
        await screen.unmount();
    } finally {
        storage.setState(previous, true);
        await pictureStore.remove(localId);
    }
});

it('decides the Wallpaper veil at the window\'s middle for every surface, so Home and a Project read as one look', async () => {
    const { wallpaperToneRegions } = await import('./AtmosphereLayer');
    const frame = { x: 0, y: 0, width: 1440, height: 1000 };
    const rect = { x: 440, y: 40, width: 1000, height: 960 };
    // Home stands its head lines mid-window; a Project stands its tabs at the top.
    const home = wallpaperToneRegions(frame, { rect, band: 0, horizonAt: 0.86, focus: { x: 500, y: 400 } });
    const project = wallpaperToneRegions(frame, { rect, band: 110, horizonAt: 0.86, focus: { x: 500, y: 45 } });
    expect(project.look).toEqual(home.look);
    expect(project.at).toEqual(home.at);
    // The veil still holds the Project's own head lines: its reach spans from the middle to their band.
    for (const regions of [home, project]) {
        expect(regions.at.y - regions.reach.y).toBeLessThanOrEqual(regions.heads.y0 + 1e-9);
        expect(regions.at.y + regions.reach.y).toBeGreaterThanOrEqual(regions.heads.y1 - 1e-9);
        expect(regions.at.y - regions.reach.y).toBeLessThanOrEqual(regions.look.y0 + 1e-9);
    }
});

it('veils the whole column where cards come to rest, wherever a surface stands its head lines', async () => {
    const { wallpaperToneRegions } = await import('./AtmosphereLayer');
    const frame = { x: 0, y: 0, width: 1440, height: 1000 };
    const rect = { x: 440, y: 40, width: 1000, height: 960 };
    // The Wallpaper stays put while the page scrolls, so a card can rest anywhere in the pane's column: over the
    // picture's bright horizon in the lower half too, not only around the head lines (FA22 GL1e).
    for (const focusY of [400, 45, 600]) {
        const regions = wallpaperToneRegions(frame, { rect, band: 0, horizonAt: 0.86, focus: { x: 500, y: focusY } });
        expect(regions.at.y - regions.reach.y).toBeLessThanOrEqual(rect.y / frame.height + 1e-9);
        expect(regions.at.y + regions.reach.y).toBeGreaterThanOrEqual((rect.y + rect.height) / frame.height - 1e-9);
        expect(regions.reach.x).toBeCloseTo(rect.width / frame.width / 2);
    }
});
