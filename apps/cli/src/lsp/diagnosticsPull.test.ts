import { describe, expect, it } from 'vitest';

import { createDiagnosticsPullScheduler } from './diagnosticsPull';

function deferred() {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function transport() {
    const requests: Array<ReturnType<typeof deferred> & { path: string; signal: AbortSignal }> = [];
    const scheduler = createDiagnosticsPullScheduler({
        // The language-server request transport is the external system boundary.
        pull: (path, signal) => {
            const request = { ...deferred(), path, signal };
            requests.push(request);
            return request.promise;
        },
    });
    return { scheduler, requests };
}

async function flushRequests() {
    await Promise.resolve();
    await Promise.resolve();
}

describe('diagnostics pull scheduler', () => {
    it('cancels and coalesces repeated document triggers, awaiting the replacement', async () => {
        const { scheduler, requests } = transport();
        expect(requests).toHaveLength(0);
        const first = scheduler.trigger('a.ts');
        await flushRequests();
        expect(requests).toHaveLength(1);

        const second = scheduler.trigger('a.ts');
        const third = scheduler.trigger('a.ts');
        expect(requests[0].signal.aborted).toBe(true);
        expect(requests).toHaveLength(1);

        requests[0].reject(new DOMException('Superseded', 'AbortError'));
        await flushRequests();
        expect(requests.map(request => request.path)).toEqual(['a.ts', 'a.ts']);
        expect(requests[1].signal.aborted).toBe(false);
        let settled = false;
        void first.then(() => { settled = true; });
        await flushRequests();
        expect(settled).toBe(false);
        requests[1].resolve();
        await Promise.all([first, second, third]);
        expect(settled).toBe(true);
        expect(requests).toHaveLength(2);
    });

    it('allows separate documents to pull concurrently and starts again after completion', async () => {
        const { scheduler, requests } = transport();
        const first = scheduler.trigger('a.ts');
        const other = scheduler.trigger('b.ts');
        await flushRequests();
        expect(requests.map(request => request.path)).toEqual(['a.ts', 'b.ts']);
        requests[0].resolve();
        await first;
        const next = scheduler.trigger('a.ts');
        await flushRequests();
        expect(requests.map(request => request.path)).toEqual(['a.ts', 'b.ts', 'a.ts']);
        expect(requests[1].signal.aborted).toBe(false);
        requests[1].resolve();
        requests[2].resolve();
        await Promise.all([other, next]);
    });

    it('cancels queued work without letting a reopened document overlap its old request', async () => {
        const { scheduler, requests } = transport();
        const first = scheduler.trigger('a.ts');
        await flushRequests();
        const queued = scheduler.trigger('a.ts');
        scheduler.cancel('a.ts');
        expect(requests[0].signal.aborted).toBe(true);
        const reopened = scheduler.trigger('a.ts');
        await flushRequests();
        expect(requests).toHaveLength(1);
        requests[0].resolve();
        await flushRequests();
        expect(requests).toHaveLength(2);
        requests[1].resolve();
        await Promise.all([first, queued, reopened]);
        const subsequent = scheduler.trigger('a.ts');
        await flushRequests();
        expect(requests).toHaveLength(3);
        requests[2].resolve();
        await subsequent;
    });

    it('drops a pending replacement on cancel and disposes every active document', async () => {
        const { scheduler, requests } = transport();
        const first = scheduler.trigger('a.ts');
        const other = scheduler.trigger('b.ts');
        await flushRequests();
        const queued = scheduler.trigger('a.ts');
        scheduler.cancel('a.ts');
        requests[0].reject(new DOMException('Closed', 'AbortError'));
        await Promise.all([first, queued]);
        expect(requests).toHaveLength(2);
        scheduler.dispose();
        expect(requests[1].signal.aborted).toBe(true);
        requests[1].reject(new DOMException('Stopped', 'AbortError'));
        await other;
        await scheduler.trigger('c.ts');
        expect(requests).toHaveLength(2);
    });

    it('exposes transport failures and permits a later explicit trigger', async () => {
        const { scheduler, requests } = transport();
        const failed = scheduler.trigger('a.ts');
        const failure = new Error('Language server failed');
        const rejection = expect(failed).rejects.toBe(failure);
        await flushRequests();
        requests[0].reject(failure);
        await rejection;
        const retry = scheduler.trigger('a.ts');
        await flushRequests();
        expect(requests).toHaveLength(2);
        requests[1].resolve();
        await retry;
    });
});
