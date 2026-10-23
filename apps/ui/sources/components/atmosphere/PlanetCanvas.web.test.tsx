import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
// This drawing-only suite does not need the root barrel's Protocol fixtures.
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { PlanetCanvas } from './PlanetCanvas.web';
import { homePlanetGeometry, homePlanetSceneOptions } from './homePlanetPlacement';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('keeps web digit redraws inside the drawing leaf at two-second cadence, preserving the scene while paused', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    // Browser fonts and the physical Canvas2D drawing surface are system boundaries.
    vi.stubGlobal('document', { documentElement: {}, fonts: { check: () => true } });
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
    const frames: string[][] = [];
    const context = { setTransform() {}, clearRect() { frames.push([]); }, beginPath() {}, arc() {}, fill() {},
        fillText(text: string) { frames.at(-1)!.push(text); } };
    const pane = { width: 280, height: 240 };
    const options = homePlanetSceneOptions(homePlanetGeometry('corner', pane), pane,
        { theme: 'dark', style: 'balanced', digits: true });
    const ready = vi.fn();
    let parentRenders = 0;
    function Scene({ paused = false }: { paused?: boolean }) {
        parentRenders += 1;
        return <PlanetCanvas {...pane} options={options} retype={{ paused }} onReady={ready} />;
    }
    const screen = await renderScreen(<Scene />, { createNodeMock: element => element.type === 'canvas'
        ? { getContext: () => context } : null });
    const mounted = parentRenders;
    const outerProps = screen.findByType(PlanetCanvas).props;
    ready.mockClear();
    const rest = frames.at(-1)!;
    for (let tick = 0; tick < 150; tick++) await act(async () => { vi.advanceTimersByTime(2000); });
    expect(ready).toHaveBeenCalledTimes(150);
    expect(parentRenders).toBe(mounted);
    expect(screen.findByType(PlanetCanvas).props === outerProps).toBe(true);
    expect(frames.slice(1).some(frame => JSON.stringify(frame) !== JSON.stringify(rest))).toBe(true);
    await screen.update(<Scene paused />);
    ready.mockClear();
    await act(async () => { vi.advanceTimersByTime(6000); });
    expect(ready).not.toHaveBeenCalled();
    await screen.update(<Scene />);
    ready.mockClear();
    await act(async () => { vi.advanceTimersByTime(1999); });
    expect(ready).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(ready).toHaveBeenCalledOnce();
    await screen.unmount();
    expect(vi.getTimerCount()).toBe(0);
});
