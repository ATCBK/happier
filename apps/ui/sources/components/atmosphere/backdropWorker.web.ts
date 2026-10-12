import type { AtmospherePixels } from '@happier-dev/brand/atmosphere';
import type { BackdropRenderRequest, BackdropWorkerResponse } from './backdropCanvas.types';

/** The public asset is produced by the existing UI postinstall/esbuild route. No main-thread fallback. */
export function createBackdropWorker() {
    const worker = new Worker('/happier-atmosphere-worker.js');
    let id = 0;
    let stopped: Error | undefined;
    const pending = new Map<number, { resolve: (pixels: AtmospherePixels) => void; reject: (error: Error) => void }>();
    const rejectAll = (error: Error) => { for (const job of pending.values()) job.reject(error); pending.clear(); };
    worker.onmessage = (event: MessageEvent<BackdropWorkerResponse>) => {
        const reply = event.data;
        if (typeof reply.id !== 'number') return;
        const job = pending.get(reply.id);
        if (!job) return;
        pending.delete(reply.id);
        if (reply.ok) job.resolve(reply.result); else job.reject(new Error(reply.error));
    };
    worker.onerror = event => { stopped = new Error(event.message || 'Atmosphere worker failed'); worker.terminate(); rejectAll(stopped); };
    return {
        render(request: BackdropRenderRequest): Promise<AtmospherePixels> {
            if (stopped) return Promise.reject(stopped);
            return new Promise((resolve, reject) => {
                const next = ++id;
                pending.set(next, { resolve, reject });
                try { worker.postMessage({ id: next, request }); }
                catch (error) { pending.delete(next); reject(error); }
            });
        },
        dispose() { stopped = new Error('Atmosphere canvas unmounted'); worker.terminate(); rejectAll(stopped); },
    };
}
