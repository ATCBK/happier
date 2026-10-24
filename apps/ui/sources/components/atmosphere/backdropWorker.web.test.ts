import { afterEach, expect, it, vi } from 'vitest';
import { createBackdropWorker } from './backdropWorker.web';
import type { BackdropRenderRequest, BackdropWorkerRequest, BackdropWorkerResponse } from './backdropCanvas.types';

afterEach(() => vi.unstubAllGlobals());

function workerBoundary() {
    const handles: WorkerBoundary[] = [];
    // Physical workers, error events and message delivery are the browser boundary.
    class WorkerBoundary {
        onerror: ((event: { message: string }) => void) | null = null;
        onmessage: ((event: { data: BackdropWorkerResponse }) => void) | null = null;
        requests: Extract<BackdropWorkerRequest, { request: unknown }>[] = [];
        stopped = false;
        constructor() { handles.push(this); }
        postMessage(message: Extract<BackdropWorkerRequest, { request: unknown }>) { this.requests.push(message); }
        terminate() { this.stopped = true; }
        reply(index = 0) {
            const { id, request } = this.requests[index];
            this.onmessage?.({ data: { id, ok: true, result: {
                rgba: new Uint8ClampedArray(request.width * request.height * 4), w: request.width, h: request.height,
            } } });
        }
    }
    vi.stubGlobal('Worker', WorkerBoundary);
    return handles;
}

const request: BackdropRenderRequest = { source: { rgba: new Uint8ClampedArray(4), w: 1, h: 1 }, width: 1, height: 1,
    job: { look: 'original', theme: 'light', page: [245, 245, 245] } };

it('replays failed in-flight demand on one fresh worker and reuses it for later demand', async () => {
    const handles = workerBoundary();
    const worker = createBackdropWorker();
    const first = worker.render(request);
    const second = worker.render({ ...request, width: 2 });
    // Observe both outcomes even when the assertion below catches a missing replacement first.
    const outcomes = Promise.allSettled([first, second]);
    handles[0].onerror!({ message: 'worker crashed' });
    expect(handles).toHaveLength(2);
    expect(handles[0].stopped).toBe(true);
    expect(handles[1].requests.map(message => message.request)).toEqual([request, { ...request, width: 2 }]);
    handles[1].reply(); handles[1].reply(1);
    await expect(first).resolves.toMatchObject({ w: 1, h: 1 });
    await expect(second).resolves.toMatchObject({ w: 2, h: 1 });
    expect((await outcomes).every(outcome => outcome.status === 'fulfilled')).toBe(true);
    const next = worker.render(request);
    handles[1].reply(2);
    await expect(next).resolves.toMatchObject({ w: 1 });
    expect(handles).toHaveLength(2);
    worker.dispose();
});

it('settles a failed replacement without further attempts and admits subsequent new demand', async () => {
    const handles = workerBoundary();
    const worker = createBackdropWorker();
    const outcome = worker.render(request).then(() => null, (error: Error) => error);
    handles[0].onerror!({ message: 'initial crash' });
    expect(handles).toHaveLength(2);
    handles[1].onerror!({ message: 'replacement crashed' });
    expect(await outcome).toMatchObject({ message: 'replacement crashed' });
    expect(handles).toHaveLength(2);
    expect(handles.every(handle => handle.stopped)).toBe(true);
    const next = worker.render(request);
    expect(handles).toHaveLength(3);
    handles[2].reply();
    await expect(next).resolves.toMatchObject({ w: 1 });
    worker.dispose();
});

it('does not retry a replied render error or discard its healthy worker', async () => {
    const handles = workerBoundary();
    const worker = createBackdropWorker();
    const failure = expect(worker.render(request)).rejects.toThrow('decode failed');
    handles[0].onmessage!({ data: { id: handles[0].requests[0].id, ok: false, error: 'decode failed' } });
    await failure;
    expect(handles).toHaveLength(1);
    expect(handles[0].requests).toHaveLength(1);
    expect(handles[0].stopped).toBe(false);
    const next = worker.render(request);
    handles[0].reply(1);
    await expect(next).resolves.toMatchObject({ w: 1 });
    worker.dispose();
});

it('keeps disposal terminal even if a queued crash callback arrives afterwards', async () => {
    const handles = workerBoundary();
    const worker = createBackdropWorker();
    const failure = expect(worker.render(request)).rejects.toThrow('unmounted');
    const lateError = handles[0].onerror;
    worker.dispose();
    lateError?.({ message: 'late crash' });
    await failure;
    await expect(worker.render(request)).rejects.toThrow('unmounted');
    expect(handles).toHaveLength(1);
});

it('replies ok:false for asynchronous decoding rejection and synchronous Brand render failure', async () => {
    const replies: BackdropWorkerResponse[] = [];
    const entry: {
        onmessage: ((event: { data: BackdropWorkerRequest }) => Promise<void>) | null;
        postMessage: (message: BackdropWorkerResponse) => void;
    } = { onmessage: null, postMessage: message => { replies.push(message); } };
    vi.stubGlobal('self', entry);
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('decode failed')));
    await import('./atmosphere.worker');
    await expect(entry.onmessage!({ data: { id: 1, request: { ...request, source: {
        localId: 'entry-decode', kind: 'builtin', data: new Blob(['picture']), size: 7, createdAtMs: 1,
    } } } })).resolves.toBeUndefined();
    // A negative source dimension reaches the real Brand allocation and raises RangeError.
    await expect(entry.onmessage!({ data: { id: 2, job: { ...request.job,
        source: { rgba: new Uint8ClampedArray(4), w: -1, h: 1 }, grade: null,
    } } })).resolves.toBeUndefined();
    expect(replies).toEqual([
        expect.objectContaining({ id: 1, ok: false, error: 'decode failed' }),
        expect.objectContaining({ id: 2, ok: false, error: expect.any(String) }),
    ]);
});
