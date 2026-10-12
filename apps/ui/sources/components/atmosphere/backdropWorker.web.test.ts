import { afterEach, expect, it, vi } from 'vitest';
import { createBackdropWorker } from './backdropWorker.web';
import type { BackdropRenderRequest } from './backdropCanvas.types';

afterEach(() => vi.unstubAllGlobals());

it('rejects work after a worker crash rather than leaving the next canvas render pending', async () => {
    const handles: { onerror: ((event: { message: string }) => void) | null }[] = [];
    // Worker transport and its terminal error event are genuine browser boundaries.
    vi.stubGlobal('Worker', class {
        onerror = null;
        onmessage = null;
        constructor() { handles.push(this); }
        postMessage() {}
        terminate() {}
    });
    const worker = createBackdropWorker();
    const request: BackdropRenderRequest = { source: { rgba: new Uint8ClampedArray(4), w: 1, h: 1 }, width: 1, height: 1,
        job: { look: 'original', theme: 'light', page: [245, 245, 245] } };
    const first = worker.render(request);
    handles[0].onerror!({ message: 'worker crashed' });
    await expect(first).rejects.toThrow('worker crashed');
    const next = worker.render(request).then(() => 'unexpected pixels', (error: Error) => error.message);
    await Promise.resolve(); await Promise.resolve();
    expect(await Promise.race([next, Promise.resolve('still pending')])).toBe('worker crashed');
    worker.dispose();
});
