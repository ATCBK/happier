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
import { useDiffHunkSlots } from '../hunks/useDiffHunkSlots';
import { useDiffHunkNavigation } from '../hunks/useDiffHunkNavigation';
import { renderDiffHunkRow } from '../hunks/DiffHunkRow';
import { DiffReviewCommentsViewer } from '../reviewComments/DiffReviewCommentsViewer';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// Vitest's generic extension resolution needs the actual web projection used by Metro.
vi.mock('@/components/ui/code/diff/DiffViewer', async () => import('../DiffViewer.web'));

const initialSettings = storage.getState().settings;
afterEach(() => { storage.setState({ settings: initialSettings }); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(['comment', 'range'] as const)('opens the existing Review composer from a late added-file %s gesture in split Pierre', async (gesture) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('Worker', BrowserWorker);
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0));
    vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
    const replaceSync = Object.getOwnPropertyDescriptor(CSSStyleSheet.prototype, 'replaceSync');
    Object.defineProperty(CSSStyleSheet.prototype, 'replaceSync', { configurable: true, value() {} });
    storage.setState({ settings: { ...initialSettings, filesDiffRendererMode: 'pierre', filesDiffPresentationStyle: 'split',
        // Real 2k source coordinates, without relying on absent JSDOM scroll layout. The live
        // replay owns offscreen virtualization; the renderer, gestures and comment state stay real.
        filesDiffInlineVirtualizationLineThreshold: 50_000, filesDiffReviewCommentsInlineVirtualizationLineThreshold: 50_000,
        filesDiffInlineVirtualizationByteThreshold: 1_000_000,
    } });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    // Plain-text language keeps syntax-worker transport outside this gesture contract.
    const patch = ['diff --git a/review-2000.txt b/review-2000.txt', 'new file mode 100644', '--- /dev/null', '+++ b/review-2000.txt',
        '@@ -0,0 +1,2000 @@', ...Array.from({ length: 2000 }, (_, index) => `+export const needle_${index + 1} = ${index + 1};`), ''].join('\n');
    const dispatch = (target: EventTarget, type: string) => {
        const event = new MouseEvent(type, { bubbles: true, composed: true, button: 0, buttons: type === 'pointerup' ? 0 : 1 });
        Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'mouse' }, isPrimary: { value: true } });
        target.dispatchEvent(event);
    };
    try {
        await act(async () => root.render(<DiffReviewCommentsViewer filePath="review-2000.txt" unifiedDiff={patch}
            reviewCommentsEnabled reviewCommentDrafts={[]} />));
        await vi.waitFor(() => expect(container.querySelector('diffs-container')?.shadowRoot?.querySelector('[data-column-number="1991"]')).toBeTruthy());
        const host = container.querySelector('diffs-container')!;
        const shadow = host.shadowRoot!;
        const first = shadow.querySelector('[data-column-number="1991"]')!;
        const last = shadow.querySelector('[data-column-number="1993"]')!;
        if (gesture === 'range') {
            await act(async () => { dispatch(first, 'pointerdown'); dispatch(last, 'pointermove'); dispatch(last, 'pointerup'); });
        } else {
            await act(async () => dispatch(first, 'pointermove'));
            const button = host.querySelector<HTMLButtonElement>('[data-testid="review-comment-line-affordance"]');
            expect(button).not.toBeNull();
            await act(async () => button!.click());
        }
        await vi.waitFor(() => expect(container.querySelector('[placeholder="files.reviewComments.placeholder"]')).not.toBeNull());
        expect(container.querySelector('diffs-container')).toBe(host);
        expect(host.querySelector(`[slot="annotation-additions-${gesture === 'range' ? 1993 : 1991}"] [placeholder]`)).not.toBeNull();
    } finally {
        await act(async () => root.unmount());
        container.remove();
        if (replaceSync) Object.defineProperty(CSSStyleSheet.prototype, 'replaceSync', replaceSync);
        else Reflect.deleteProperty(CSSStyleSheet.prototype, 'replaceSync');
    }
});

it.each([{ width: 1440, height: 180 }, { width: 390, height: 241 }])(
    'reveals the mounted header-start Change row with tall notes on Next and Previous in a $width by $height viewport',
    async ({ width, height }) => {
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
        Object.defineProperties(container, { clientHeight: { value: height }, scrollHeight: { value: 5000 } });
        // Inline DOM scrolling supplies the narrow regression below the deciding real-browser
        // virtualized Next/Previous replay. Only layout/scrollIntoView and browser ports are supplied;
        // slots, review units/navigation, annotations and Pierre's actual renderer remain real.
        const bounds = HTMLElement.prototype.getBoundingClientRect;
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            if (this === container) return new DOMRect(0, 0, width, height);
            if (this.getAttribute('slot') === 'annotation-additions-0') return new DOMRect(0, -container.scrollTop, width, 330);
            if (this.getAttribute('slot') === 'annotation-additions-101') return new DOMRect(0, 2560 - container.scrollTop, width, 330);
            if (/^diff-hunk-row-\d+$/.test(this.getAttribute('testid') ?? '')) {
                const slot = this.closest<HTMLElement>('[slot]')!;
                return new DOMRect(0, slot.getBoundingClientRect().top, width, 30);
            }
            if (this.hasAttribute('data-line')) {
                const line = Number(this.getAttribute('data-line'));
                return new DOMRect(0, 338 + (line - 1) * 22 - container.scrollTop, width, 22);
            }
            return bounds.call(this);
        });
        const scrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: function (this: HTMLElement, options?: boolean | ScrollIntoViewOptions) {
            const rect = this.getBoundingClientRect();
            const center = typeof options === 'object' && options.block === 'center' ? (height - rect.height) / 2 : 0;
            container.scrollTop = Math.max(0, container.scrollTop + rect.top - center);
        } });
        const root = createRoot(container);
        const patch = ['--- a/a.txt', '+++ b/a.txt', '@@ -1,103 +1,103 @@', '-old first', '+new first',
            ...Array.from({ length: 100 }, (_, index) => ` context ${index + 2}`), '-old last', '+new last', ' tail', ''].join('\n');
        const review = { actions: { keep: () => {} }, renderNote: () => <div style={{ height: 300 }}>Review note</div> };
        function Review() {
            const props = { mode: 'unified' as const, filePath: 'a.txt', unifiedDiff: patch, hunks: review };
            const slots = useDiffHunkSlots(props, renderDiffHunkRow);
            const navigation = useDiffHunkNavigation(slots.table);
            return <>
                <button onClick={navigation.next}>Next</button><button onClick={navigation.previous}>Previous</button>
                <PierreDiffViewer {...props} renderAfterLine={slots.renderAfterLine} scrollToLineId={navigation.scrollToLineId} />
            </>;
        }
        const flush = async () => act(async () => {
            const pending = [...frames.values()]; frames.clear();
            for (const frame of pending) frame(performance.now());
        });
        try {
            await act(async () => root.render(<Review />));
            await vi.waitFor(async () => {
                await flush();
                expect(container.querySelector('[testid="diff-hunk-row-0"]')).toBeTruthy();
                expect(container.querySelector('diffs-container')?.shadowRoot?.querySelector('[data-line]')).toBeTruthy();
            });
            const host = container.querySelector('diffs-container')!;
            const pre = host.shadowRoot!.querySelector('pre');
            const first = host.querySelector<HTMLElement>('[slot="annotation-additions-0"]')!;
            const second = host.querySelector<HTMLElement>('[slot="annotation-additions-101"]')!;
            const visible = (row: HTMLElement) => {
                const rect = row.querySelector<HTMLElement>('[testid="diff-hunk-row-0"], [testid="diff-hunk-row-1"]')!.getBoundingClientRect();
                expect(rect.top).toBeGreaterThanOrEqual(0);
                expect(rect.bottom).toBeLessThanOrEqual(height);
            };
            const move = async (name: string) => {
                await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === name)!.click());
                await vi.waitFor(async () => { await flush(); expect(frames.size).toBe(0); });
            };
            await move('Next');
            visible(first);
            await move('Next');
            visible(second);
            await move('Previous');
            visible(first);
            expect(container.querySelector('diffs-container')).toBe(host);
            expect(host.shadowRoot!.querySelector('pre')).toBe(pre);
            container.scrollTop = 300;
            await act(async () => root.render(<Review />));
            await flush();
            expect(container.scrollTop).toBe(300);
        } finally {
            await act(async () => root.unmount());
            container.remove();
            if (replaceSync) Object.defineProperty(CSSStyleSheet.prototype, 'replaceSync', replaceSync);
            else Reflect.deleteProperty(CSSStyleSheet.prototype, 'replaceSync');
            if (scrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoView);
            else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
        }
    },
);

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
    const render = (reviewedLineIds?: ReadonlySet<string>, agentPresence?: React.ComponentProps<typeof PierreDiffViewer>['agentPresence']) => root.render(<VirtualizerContext.Provider value={virtualizer}>
        <PierreDiffViewer mode="unified" filePath="a.txt" unifiedDiff={patch} wrapLines reviewedLineIds={reviewedLineIds} agentPresence={agentPresence}
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
        // Track's caret and wash are paint too: the written line carries them, the measured heights hold.
        await act(async () => { render(undefined, { startLine: 2, endLine: 2, agentId: 'claude', agentName: 'Claude', reducedMotion: false }); });
        const caretLines = host.shadowRoot!.querySelectorAll<HTMLElement>('[data-line][data-happier-agent-caret]');
        expect(caretLines).toHaveLength(1);
        expect(caretLines[0]!.getAttribute('data-happier-agent-caret')).toBe('Claude');
        expect(caretLines[0]!.hasAttribute('data-happier-agent-wash')).toBe(true);
        expect(caretLines[0]!.style.getPropertyValue('--happier-agent-mark')).toMatch(/^url\(/);
        expect(Math.min(height, instance.getVirtualizedHeight(), ...heights)).toBe(height);
        await act(async () => { render(); });
        expect(host.shadowRoot!.querySelectorAll('[data-happier-agent-caret], [data-happier-agent-wash]')).toHaveLength(0);
    } finally {
        await act(async () => root.unmount());
        virtualizer.cleanUp();
        container.remove();
        if (replaceSync) Object.defineProperty(CSSStyleSheet.prototype, 'replaceSync', replaceSync);
        else Reflect.deleteProperty(CSSStyleSheet.prototype, 'replaceSync');
    }
});
