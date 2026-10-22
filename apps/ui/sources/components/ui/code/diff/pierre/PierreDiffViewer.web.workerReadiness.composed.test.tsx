// @vitest-environment jsdom
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { storage } from '@/sync/domains/state/storageStore';
import { BrowserWorker } from './pierreWorkerTestHelpers';
import { PierreDiffViewer } from './PierreDiffViewer.web';
import { getPierreDiffWorkerPool, getPierreDiffWorkerPoolFailed } from './pierreWorkerPool.web';
import { InitialPresentationReadinessProvider } from '@/components/ui/presentation/InitialPresentationReadinessContext';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

it('keeps both diff inputs readable before worker readiness, hands over on readiness, and recovers from a worker error', async () => {
    // Hold only the browser Worker reply: pool, renderer selection and both renderers stay real.
    BrowserWorker.reset();
    BrowserWorker.holdInitialization = true;
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('Worker', BrowserWorker);
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0));
    vi.stubGlobal('cancelAnimationFrame', (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));
    const replaceSync = Object.getOwnPropertyDescriptor(CSSStyleSheet.prototype, 'replaceSync');
    Object.defineProperty(CSSStyleSheet.prototype, 'replaceSync', { configurable: true, value() {} });
    const settings = storage.getState().settings;
    storage.setState({ settings: { ...settings, filesDiffPresentationStyle: 'unified' } });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const presentation = { complete: vi.fn(), dispose: vi.fn() };
    try {
        await React.act(async () => root.render(<InitialPresentationReadinessProvider value={{
            presentationPending: true, registerProducer: () => presentation,
        }}>
            <section data-input="unified"><PierreDiffViewer mode="unified" filePath="auth.txt" virtualized={false}
                unifiedDiff={'--- a/auth.txt\n+++ b/auth.txt\n@@ -1 +1 @@\n-oldValue\n+newValue\n'} /></section>
            <section data-input="text"><PierreDiffViewer mode="text" filePath="auth.txt" virtualized={false}
                oldText={'oldValue\n'} newText={'newValue\n'} /></section>
        </InitialPresentationReadinessProvider>));
        const pool = getPierreDiffWorkerPool({ style: 'unified' });
        if (!pool) throw new Error('Expected the real worker pool');
        await vi.waitFor(() => expect(BrowserWorker.pendingInitializations.length).toBeGreaterThan(0));
        expect(pool.isInitialized()).toBe(false);
        expect(getPierreDiffWorkerPoolFailed('unified')).toBe(false);
        for (const section of host.querySelectorAll('section')) {
            expect(section.textContent).toContain('oldValue');
            expect(section.textContent).toContain('newValue');
        }
        expect(presentation.complete).toHaveBeenCalled();
        await React.act(async () => {
            for (const reply of BrowserWorker.pendingInitializations.splice(0)) reply();
            await pool.initialize();
        });
        await vi.waitFor(() => {
            for (const section of host.querySelectorAll('section')) {
                const body = section.querySelector('diffs-container');
                expect(body).not.toBeNull();
                expect(body?.shadowRoot?.textContent).toContain('newValue');
            }
        });
        expect(getPierreDiffWorkerPoolFailed('unified')).toBe(false);
        const worker = BrowserWorker.instances.find(candidate => !candidate.terminated);
        if (!worker) throw new Error('Expected an initialized worker');
        await React.act(async () => { worker.dispatchEvent(new Event('error', { cancelable: true })); });
        expect(getPierreDiffWorkerPoolFailed('unified')).toBe(true);
        for (const section of host.querySelectorAll('section')) expect(section.textContent).toContain('newValue');
    } finally {
        await React.act(async () => root.unmount());
        getPierreDiffWorkerPool({ style: 'unified' })?.terminate();
        host.remove();
        storage.setState({ settings });
        if (replaceSync) Object.defineProperty(CSSStyleSheet.prototype, 'replaceSync', replaceSync);
        else Reflect.deleteProperty(CSSStyleSheet.prototype, 'replaceSync');
        BrowserWorker.reset();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    }
});
