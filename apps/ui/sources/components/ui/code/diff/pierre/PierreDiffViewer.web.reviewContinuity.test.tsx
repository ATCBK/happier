/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Virtualizer, VirtualizedFileDiff } from '@pierre/diffs';
import { VirtualizerContext } from '@pierre/diffs/react';
import { storage } from '@/sync/domains/state/storageStore';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import { BrowserWorker } from './pierreWorkerTestHelpers';
import { PierreDiffViewer } from './PierreDiffViewer.web';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

const initialSettings = storage.getState().settings;
afterEach(() => { storage.setState({ settings: initialSettings }); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('keeps the real Pierre body and measured wrapped height when only review marks change', async () => {
    // JSDOM supplies no layout, observers or worker transport. The adapter, React renderer and
    // Pierre virtualizer/height reconciliation are real; only these browser ports are supplied.
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('Worker', BrowserWorker);
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
    let frameId = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    const replaceSync = Object.getOwnPropertyDescriptor(CSSStyleSheet.prototype, 'replaceSync');
    Object.defineProperty(CSSStyleSheet.prototype, 'replaceSync', { configurable: true, value() {} });
    storage.setState({ settings: { ...initialSettings, filesDiffPresentationStyle: 'unified' } });
    const container = document.createElement('div');
    document.body.append(container);
    Object.defineProperties(container, { clientHeight: { value: 241 }, scrollHeight: { value: 950 } });
    container.scrollTo = () => {};
    const virtualizer = new Virtualizer();
    let connectedDiff: VirtualizedFileDiff | undefined;
    const connect = virtualizer.connect.bind(virtualizer);
    vi.spyOn(virtualizer, 'connect').mockImplementation((host, instance) => {
        if (instance instanceof VirtualizedFileDiff) connectedDiff = instance;
        return connect(host, instance);
    });
    virtualizer.setup(container);
    const root = createRoot(container);
    const patch = '--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n before\n-old wrapped line\n+new wrapped line\n after\n';
    const changed = buildCodeLinesFromUnifiedDiff({ unifiedDiff: patch, hideFilePrelude: true }).filter(line => line.kind === 'add' || line.kind === 'remove');
    const render = (reviewedLineIds?: ReadonlySet<string>) => root.render(<VirtualizerContext.Provider value={virtualizer}>
        <PierreDiffViewer mode="unified" filePath="a.txt" unifiedDiff={patch} wrapLines reviewedLineIds={reviewedLineIds}
            renderAfterLine={line => line.kind === 'add' ? <div>Keep</div> : null} />
    </VirtualizerContext.Provider>);
    try {
        await act(async () => { render(); });
        await vi.waitFor(async () => {
            await act(async () => {
                const pending = [...frames.values()];
                frames.clear();
                for (const frame of pending) frame(performance.now());
            });
            expect(container.querySelector('diffs-container')?.shadowRoot?.querySelector('[data-line]')).toBeTruthy();
        });
        const host = container.querySelector<HTMLElement>('diffs-container')!;
        const pre = host.shadowRoot!.querySelector('pre');
        const instance = connectedDiff;
        if (!instance) throw new Error('Pierre did not connect its virtualized diff');
        for (const line of host.shadowRoot!.querySelectorAll<HTMLElement>('[data-line-index]')) {
            vi.spyOn(line, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 100));
        }
        instance.reconcileHeights();
        const height = instance.getVirtualizedHeight();
        expect(height).toBeGreaterThan(300);
        const heights: number[] = [];
        const setOptions = instance.setOptions.bind(instance);
        // Observe the real renderer's public measured-height output at the update boundary,
        // including a transient reset before its later DOM measurement can repair it.
        vi.spyOn(instance, 'setOptions').mockImplementation(options => { setOptions(options); heights.push(instance.getVirtualizedHeight()); });
        await act(async () => { render(new Set(changed.map(line => line.id))); });
        expect(container.querySelector('diffs-container')).toBe(host);
        expect(host.shadowRoot!.querySelector('pre')).toBe(pre);
        expect(Math.min(height, instance.getVirtualizedHeight(), ...heights)).toBe(height);
        expect(host.shadowRoot!.querySelectorAll('[data-happier-reviewed]').length).toBeGreaterThan(0);
        expect(host.shadowRoot!.querySelectorAll('[data-happier-reviewed][data-column-number]').length).toBeGreaterThan(0);
        await act(async () => { render(); });
        expect(host.shadowRoot!.querySelectorAll('[data-happier-reviewed]')).toHaveLength(0);
        expect(Math.min(height, instance.getVirtualizedHeight(), ...heights)).toBe(height);
    } finally {
        await act(async () => root.unmount());
        virtualizer.cleanUp();
        container.remove();
        if (replaceSync) Object.defineProperty(CSSStyleSheet.prototype, 'replaceSync', replaceSync);
        else Reflect.deleteProperty(CSSStyleSheet.prototype, 'replaceSync');
    }
});
