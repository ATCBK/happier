import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerPoolManager } from '@pierre/diffs/worker';

// Workers are the browser/process boundary; the real Pierre manager, theme registry,
// and Happier pool owner run beneath this transport.
class BrowserWorker extends EventTarget {
    static instances: BrowserWorker[] = [];
    static successfulConstructionsBeforeFailure: number | undefined;
    terminated = false;

    constructor() {
        super();
        if (BrowserWorker.successfulConstructionsBeforeFailure === 0) throw new Error('worker disabled');
        if (BrowserWorker.successfulConstructionsBeforeFailure !== undefined) BrowserWorker.successfulConstructionsBeforeFailure--;
        BrowserWorker.instances.push(this);
    }

    postMessage(message: unknown): void {
        if (typeof message !== 'object' || message === null || !('id' in message) || !('type' in message)) {
            throw new Error('Expected a Pierre worker request');
        }
        const { id, type } = message;
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
            data: { type: 'success', requestType: type, id, sentAt: Date.now() },
        })));
    }

    terminate(): void {
        this.terminated = true;
    }
}

const pools: WorkerPoolManager[] = [];

beforeEach(() => {
    vi.resetModules();
    BrowserWorker.instances = [];
    BrowserWorker.successfulConstructionsBeforeFailure = undefined;
    vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
    vi.stubGlobal('document', { baseURI: 'http://localhost/' });
    vi.stubGlobal('Worker', BrowserWorker);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0));
    vi.stubGlobal('cancelAnimationFrame', (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));
    vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(async () => {
    for (const pool of pools.splice(0)) pool.terminate();
    // Let the manager's final animation-frame broadcast finish while its browser
    // clock boundary is still installed.
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('getPierreDiffWorkerPool', () => {
    it('returns null and logs once when the browser cannot construct a worker', async () => {
        BrowserWorker.successfulConstructionsBeforeFailure = 0;
        const { getPierreDiffWorkerPool } = await import('./pierreWorkerPool.web');

        expect(getPierreDiffWorkerPool({ style: 'unified' })).toBeNull();
        expect(getPierreDiffWorkerPool({ style: 'unified' })).toBeNull();
        expect(console.debug).toHaveBeenCalledTimes(1);
        expect(console.debug).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: 'worker disabled' }));
    });

    it('fails the pool if worker construction fails during asynchronous initialization', async () => {
        BrowserWorker.successfulConstructionsBeforeFailure = 1;
        const { getPierreDiffWorkerPool } = await import('./pierreWorkerPool.web');
        const pool = getPierreDiffWorkerPool({ style: 'unified' });
        if (!pool) throw new Error('Expected the preflight to succeed');
        pools.push(pool);

        await expect(pool.initialize()).rejects.toThrow('worker disabled');
        await Promise.resolve();

        expect(getPierreDiffWorkerPool({ style: 'unified' })).toBeNull();
        expect(console.debug).toHaveBeenCalledTimes(1);
    });

    it('fails only the affected style after a worker error and releases its workers', async () => {
        const owner = await import('./pierreWorkerPool.web');
        const unified = owner.getPierreDiffWorkerPool({ style: 'unified' });
        if (!unified) throw new Error('Expected a unified pool');
        pools.push(unified);
        await unified.initialize();
        const worker = BrowserWorker.instances.find((candidate) => !candidate.terminated);
        if (!worker) throw new Error('Expected a live unified worker');
        const split = owner.getPierreDiffWorkerPool({ style: 'split' });
        if (!split) throw new Error('Expected a split pool');
        pools.push(split);
        await split.initialize();

        const event = new Event('error', { cancelable: true });
        worker.dispatchEvent(event);

        expect(owner.getPierreDiffWorkerPool({ style: 'unified' })).toBeNull();
        expect(owner.getPierreDiffWorkerPool({ style: 'split' })).toBe(split);
        expect(worker.terminated).toBe(true);
        expect(event.defaultPrevented).toBe(true);
        worker.dispatchEvent(new Event('error'));
        expect(console.debug).toHaveBeenCalledTimes(1);
    });

    it('reuses a style pool when the effective theme changes', async () => {
        const { getPierreDiffWorkerPool } = await import('./pierreWorkerPool.web');
        const { ensureHappierPierreThemeRegistered, resolveHappierPierreThemeIds } = await import('./pierreThemeRegistry.web');
        const pool = getPierreDiffWorkerPool({ style: 'split' });
        if (!pool) throw new Error('Expected a split pool');
        pools.push(pool);
        await pool.initialize();
        const colors = { text: { primary: '#123456' } };
        ensureHappierPierreThemeRegistered({ isDark: false, colors });
        const themeIds = resolveHappierPierreThemeIds({ isDark: false, colors });

        expect(getPierreDiffWorkerPool({ style: 'split', themeIds })).toBe(pool);
        await vi.waitFor(() => expect(pool.getDiffRenderOptions().theme).toEqual(themeIds));
    });
});
