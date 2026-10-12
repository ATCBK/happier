import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { BackdropCanvas } from './BackdropCanvas.web';
import type { BackdropWorkerRequest, BackdropWorkerResponse } from './backdropCanvas.types';

afterEach(() => vi.unstubAllGlobals());

it('paints both pane projections from one common worker render and releases it after the last projection', async () => {
    const workers: { stopped: boolean }[] = [];
    let jobs = 0;
    vi.stubGlobal('Worker', class {
        onmessage: ((event: { data: BackdropWorkerResponse }) => void) | null = null;
        stopped = false;
        constructor() { workers.push(this); }
        postMessage(message: BackdropWorkerRequest) {
            jobs++;
            if (!('request' in message)) return;
            const { width: w, height: h, source } = message.request;
            const value = 'rgba' in source ? source.rgba[0] : 125;
            queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ok: true,
                result: { rgba: new Uint8ClampedArray(w * h * 4).fill(value), w, h } } }));
        }
        terminate() { this.stopped = true; }
    });
    vi.stubGlobal('ImageData', class {
        constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    });
    const painted: unknown[] = [];
    let source = { rgba: new Uint8ClampedArray(16).fill(10), w: 2, h: 2 };
    const renderGroup = {};
    const picture = (id: string) => <BackdropCanvas key={id} source={source} size={{ width: 8, height: 4 }}
        look="original" page={[245, 245, 245]} theme="light" dpr={1} renderGroup={renderGroup} testID={id} />;
    const screen = await renderScreen(<>{picture('home')}{picture('project')}</>, {
        createNodeMock: element => element.type === 'canvas' ? {
            getContext: () => ({ putImageData: (pixels: unknown) => painted.push(pixels) }),
        } : null,
    });
    expect(painted).toHaveLength(2);
    expect(jobs).toBe(1);
    expect(workers).toHaveLength(1);
    await screen.update(<>{picture('project')}</>);
    expect(workers[0].stopped).toBe(false);
    source = { ...source, rgba: new Uint8ClampedArray(16).fill(90) };
    await screen.update(<>{picture('project')}</>);
    expect(painted.at(-1)).toMatchObject({ data: new Uint8ClampedArray(8 * 4 * 4).fill(90) });
    expect(jobs).toBe(2);
    expect(workers[0].stopped).toBe(true);
    await screen.unmount();
    expect(workers.every(worker => worker.stopped)).toBe(true);
});
