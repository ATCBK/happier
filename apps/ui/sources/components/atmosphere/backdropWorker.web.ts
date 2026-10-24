import type { AtmospherePixels } from '@happier-dev/brand/atmosphere';
import type { BackdropRenderRequest, BackdropWorkerResponse } from './backdropCanvas.types';

/** The public asset is produced by the existing UI postinstall/esbuild route. No main-thread fallback. */
export function createBackdropWorker() {
    let worker: Worker | null = null;
    let id = 0;
    let stopped: Error | undefined;
    type PendingRender = {
        request: BackdropRenderRequest;
        replacementUsed: boolean;
        resolve: (pixels: AtmospherePixels) => void;
        reject: (error: Error) => void;
    };
    const pending = new Map<number, PendingRender>();
    const rejectAll = (error: Error) => { for (const job of pending.values()) job.reject(error); pending.clear(); };
    const dropWorker = () => {
        if (!worker) return;
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
        worker = null;
    };
    function currentWorker(): Worker {
        if (worker) return worker;
        const created = new Worker('/happier-atmosphere-worker.js');
        worker = created;
        created.onmessage = (event: MessageEvent<BackdropWorkerResponse>) => {
            if (worker !== created) return;
            const reply = event.data;
            if (typeof reply.id !== 'number') return;
            const job = pending.get(reply.id);
            if (!job) return;
            pending.delete(reply.id);
            if (reply.ok) job.resolve(reply.result); else job.reject(new Error(reply.error));
        };
        created.onerror = event => {
            if (worker !== created) return;
            const error = new Error(event.message || 'Atmosphere worker failed');
            const failed = [...pending];
            pending.clear();
            dropWorker();
            // A browser worker crash is distinct from an ok:false render reply. Each outstanding
            // request gets one replacement attempt, shared on the same fresh physical worker.
            for (const [requestId, job] of failed) {
                if (job.replacementUsed) job.reject(error);
                else { job.replacementUsed = true; post(requestId, job); }
            }
        };
        return created;
    }
    function post(requestId: number, job: PendingRender) {
        try {
            const active = currentWorker();
            pending.set(requestId, job);
            active.postMessage({ id: requestId, request: job.request });
        } catch (error) {
            pending.delete(requestId);
            job.reject(error instanceof Error ? error : new Error(String(error)));
        }
    }
    return {
        render(request: BackdropRenderRequest): Promise<AtmospherePixels> {
            if (stopped) return Promise.reject(stopped);
            return new Promise((resolve, reject) => {
                post(++id, { request, replacementUsed: false, resolve, reject });
            });
        },
        dispose() { stopped = new Error('Atmosphere canvas unmounted'); dropWorker(); rejectAll(stopped); },
    };
}
