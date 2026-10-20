/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { Virtualizer as PierreVirtualizer } from '@pierre/diffs';

const setupSpy = vi.fn();
const cleanUpSpy = vi.fn();
const constructorSpy = vi.fn();
const connectSpy = vi.fn();
const disconnectSpy = vi.fn();

vi.mock('@pierre/diffs', () => {
    class Virtualizer {
        constructor() { constructorSpy(); }
        setup = setupSpy;
        cleanUp = cleanUpSpy;
        connect(container: unknown, instance: unknown) { connectSpy(container, instance); return () => this.disconnect(container); }
        disconnect(container: unknown) { disconnectSpy(container); }
    }
    return { Virtualizer };
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function loadDemandedProvider() {
    const { PierreScrollRootVirtualizerProvider, usePierreScrollRootVirtualizer } = await import('./PierreScrollRootVirtualizerProvider.web');
    const { Virtualizer } = await import('@pierre/diffs');
    function Demand(props: Readonly<{ children: React.ReactNode }>) {
        usePierreScrollRootVirtualizer(() => new Virtualizer());
        return <>{props.children}</>;
    }
    return {
        PierreScrollRootVirtualizerProvider: (props: Readonly<{ children: React.ReactNode }>) => (
            <PierreScrollRootVirtualizerProvider><Demand>{props.children}</Demand></PierreScrollRootVirtualizerProvider>
        ),
    };
}

function defineSizeProperty(node: Element, property: 'clientHeight' | 'scrollHeight', value: number): void {
    Object.defineProperty(node, property, {
        configurable: true,
        get: () => value,
    });
}

type ScrollRecorder = Readonly<{
    writes: string[];
    scrollToCalls: unknown[][];
    originalScrollTo: () => void;
}>;

/**
 * Instrument an element so every scroll mutation attempted against it is observable:
 * - direct `scrollTop` / `scrollLeft` assignments are recorded,
 * - `scrollTo(...)` invocations are recorded,
 * - the installed `scrollTo` identity is captured so a replacement is detectable.
 */
function instrumentScrollElement(
    node: HTMLElement,
    input?: Readonly<{ honorsDomScrollToOptions?: boolean }>,
): ScrollRecorder {
    const writes: string[] = [];
    const scrollToCalls: unknown[][] = [];
    let scrollTop = 0;
    let scrollLeft = 0;

    Object.defineProperty(node, 'scrollTop', {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
            writes.push(`scrollTop=${value}`);
            scrollTop = Number.isFinite(value) ? value : 0;
        },
    });
    Object.defineProperty(node, 'scrollLeft', {
        configurable: true,
        get: () => scrollLeft,
        set: (value: number) => {
            writes.push(`scrollLeft=${value}`);
            scrollLeft = Number.isFinite(value) ? value : 0;
        },
    });

    const honorsDomScrollToOptions = input?.honorsDomScrollToOptions ?? true;
    const originalScrollTo = (...args: unknown[]) => {
        scrollToCalls.push(args);
        const first = args[0];
        if (first && typeof first === 'object') {
            if (!honorsDomScrollToOptions) return;
            const anyFirst = first as any;
            if (typeof anyFirst.top === 'number') scrollTop = anyFirst.top;
            if (typeof anyFirst.left === 'number') scrollLeft = anyFirst.left;
            return;
        }
        if (typeof args[0] === 'number') scrollLeft = args[0] as number;
        if (typeof args[1] === 'number') scrollTop = args[1] as number;
    };
    (node as any).scrollTo = originalScrollTo;

    return { writes, scrollToCalls, originalScrollTo };
}

describe('PierreScrollRootVirtualizerProvider (web)', () => {
    it('forgets real Pierre diffs cleaned up by direct disconnect before a root rebind', async () => {
        const { Virtualizer, VirtualizedFileDiff } = await vi.importActual<typeof import('@pierre/diffs')>('@pierre/diffs');
        const { PierreScrollRootVirtualizerProvider, usePierreScrollRootVirtualizer } = await import('./PierreScrollRootVirtualizerProvider.web');
        const observe = vi.fn();
        const unobserve = vi.fn();
        // DOM observers and animation frames are the browser boundary; Pierre's lifecycle stays real.
        vi.stubGlobal('IntersectionObserver', class { observe = observe; unobserve = unobserve; disconnect() {} });
        vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
        const frames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
        const virtualizer = new Virtualizer();
        const connect = vi.spyOn(virtualizer, 'connect');
        const retired = new VirtualizedFileDiff({}, virtualizer);
        const retained = new VirtualizedFileDiff({}, virtualizer);
        const retiredContainer = document.createElement('div');
        const retainedContainer = document.createElement('div');
        for (const node of [retiredContainer, retainedContainer]) {
            vi.spyOn(node, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 20_000, 0, 0));
        }
        function Demand() {
            usePierreScrollRootVirtualizer(() => virtualizer);
            React.useEffect(() => {
                const input = { oldFile: { name: 'a.ts', contents: 'before\n' }, newFile: { name: 'a.ts', contents: 'after\n' } };
                retired.render({ ...input, fileContainer: retiredContainer });
                retained.render({ ...input, fileContainer: retainedContainer });
                return () => { retired.cleanUp(); retained.cleanUp(); };
            }, []);
            return null;
        }
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        let scroller: HTMLDivElement | null = null;
        try {
            await act(async () => root.render(<PierreScrollRootVirtualizerProvider><Demand /><div ref={node => {
                if (!node) return;
                scroller = node;
                node.style.overflowY = 'auto';
                defineSizeProperty(node, 'clientHeight', 120);
                defineSizeProperty(node, 'scrollHeight', 120);
            }} /></PierreScrollRootVirtualizerProvider>));
            expect(observe).toHaveBeenCalledWith(retiredContainer);
            retired.cleanUp(); // beta.13 ignores connect's returned disposer and calls disconnect itself.
            expect(unobserve).toHaveBeenCalledWith(retiredContainer);
            connect.mockClear();
            defineSizeProperty(scroller!, 'scrollHeight', 580);
            await act(async () => { for (const frame of frames.splice(0)) frame(0); });
            expect(connect.mock.calls.map(([node]) => node)).toEqual([retainedContainer]);
        } finally {
            await act(async () => root.unmount());
            container.remove();
            vi.unstubAllGlobals();
        }
    });
    it('keeps a diff list mounted without activating Pierre before a renderer needs it', async () => {
        vi.resetModules();
        setupSpy.mockClear();
        cleanUpSpy.mockClear();
        constructorSpy.mockClear();
        vi.stubGlobal('IntersectionObserver', class {});
        vi.stubGlobal('ResizeObserver', class {});

        const { PierreScrollRootVirtualizerProvider } = await import('./PierreScrollRootVirtualizerProvider.web');
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        try {
            await act(async () => {
                root.render(React.createElement(PierreScrollRootVirtualizerProvider, null,
                    React.createElement('input', { defaultValue: 'retained list state' })));
            });
            expect(container.querySelector('input')?.value).toBe('retained list state');
            expect(setupSpy).not.toHaveBeenCalled();
            expect(constructorSpy).not.toHaveBeenCalled();
        } finally {
            await act(async () => root.unmount());
            container.remove();
            vi.unstubAllGlobals();
        }
    });

    it('shares the demanded instance while retaining list state and scroll through renderer changes', async () => {
        vi.resetModules();
        setupSpy.mockClear();
        cleanUpSpy.mockClear();
        constructorSpy.mockClear();
        vi.stubGlobal('IntersectionObserver', class {});
        vi.stubGlobal('ResizeObserver', class {});
        const { PierreScrollRootVirtualizerProvider, usePierreScrollRootVirtualizer } = await import('./PierreScrollRootVirtualizerProvider.web');
        const { Virtualizer } = await import('@pierre/diffs');
        const instances: PierreVirtualizer[] = [];
        let mounts = 0;
        function Demand() {
            const instance = usePierreScrollRootVirtualizer(() => new Virtualizer());
            if (instance) instances.push(instance);
            return null;
        }
        function RetainedList() {
            React.useEffect(() => { mounts += 1; }, []);
            return <div data-testid="list"><input defaultValue="initial" /></div>;
        }
        function Contents(props: Readonly<{ demanded: boolean }>) {
            return <PierreScrollRootVirtualizerProvider>
                <RetainedList />
                {props.demanded ? <Demand /> : null}
                {props.demanded ? <Demand /> : null}
            </PierreScrollRootVirtualizerProvider>;
        }
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        try {
            await act(async () => root.render(<React.StrictMode><Contents demanded={false} /></React.StrictMode>));
            const mountsAtFirstCommit = mounts;
            const list = container.querySelector<HTMLElement>('[data-testid="list"]')!;
            const input = container.querySelector('input')!;
            list.style.overflowY = 'auto';
            defineSizeProperty(list, 'clientHeight', 120);
            defineSizeProperty(list, 'scrollHeight', 560);
            list.scrollTop = 91;
            input.value = 'user state';
            await act(async () => root.render(<React.StrictMode><Contents demanded /></React.StrictMode>));
            expect(constructorSpy).toHaveBeenCalledTimes(1);
            expect(instances[0]).toBe(instances[1]);
            expect(setupSpy.mock.calls.at(-1)?.[0]).toBe(list);
            expect(container.querySelector('[data-testid="list"]')).toBe(list);
            expect(container.querySelector('input')).toBe(input);
            expect(input.value).toBe('user state');
            expect(list.scrollTop).toBe(91);
            expect(mounts).toBe(mountsAtFirstCommit);
            const cleanupsAfterBinding = cleanUpSpy.mock.calls.length;
            await act(async () => root.render(<React.StrictMode><Contents demanded={false} /></React.StrictMode>));
            await act(async () => root.render(<React.StrictMode><Contents demanded /></React.StrictMode>));
            expect(constructorSpy).toHaveBeenCalledTimes(1);
            expect(cleanUpSpy.mock.calls.length).toBe(cleanupsAfterBinding);
            expect(instances.at(-1)).toBe(instances[0]);
            expect(input.value).toBe('user state');
            expect(list.scrollTop).toBe(91);
            expect(mounts).toBe(mountsAtFirstCommit);
            await act(async () => root.unmount());
            expect(cleanUpSpy.mock.calls.length).toBe(cleanupsAfterBinding + 1);
        } finally {
            await act(async () => root.unmount());
            container.remove();
            vi.unstubAllGlobals();
        }
    });

    it('never binds to, writes to, or patches a taller scrollable ancestor outside the diff subtree', async () => {
        vi.resetModules();
        setupSpy.mockClear();
        cleanUpSpy.mockClear();

        (globalThis as any).IntersectionObserver = class {};
        (globalThis as any).ResizeObserver = class {};

        const { PierreScrollRootVirtualizerProvider } = await loadDemandedProvider();

        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        let ancestorRoot: HTMLDivElement | null = null;
        let nestedRoot: HTMLDivElement | null = null;
        let ancestorRecorder: ScrollRecorder | null = null;

        await act(async () => {
            root.render(
                React.createElement(
                    'div',
                    {
                        // The route-level scroller (in the app: the transcript scroller). It is taller
                        // than anything inside the diff subtree, so the "largest clientHeight wins"
                        // heuristic selects it.
                        ref: (node: HTMLDivElement | null) => {
                            if (!node || node === ancestorRoot) return;
                            ancestorRoot = node;
                            node.style.overflowY = 'auto';
                            defineSizeProperty(node, 'clientHeight', 640);
                            defineSizeProperty(node, 'scrollHeight', 2400);
                            // RN-web-like host: exposes scrollTo but ignores DOM ScrollToOptions.
                            ancestorRecorder = instrumentScrollElement(node, { honorsDomScrollToOptions: false });
                        },
                    },
                    React.createElement(
                        PierreScrollRootVirtualizerProvider,
                        null,
                        React.createElement(
                            'div',
                            null,
                            React.createElement('div', {
                                ref: (node: HTMLDivElement | null) => {
                                    if (!node || node === nestedRoot) return;
                                    nestedRoot = node;
                                    node.style.overflowY = 'auto';
                                    defineSizeProperty(node, 'clientHeight', 120);
                                    defineSizeProperty(node, 'scrollHeight', 560);
                                },
                            }),
                        ),
                    ),
                ),
            );
        });

        // Let the post-mount rebind probing run.
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
        });

        expect(ancestorRoot).not.toBeNull();
        expect(nestedRoot).not.toBeNull();
        expect(ancestorRecorder).not.toBeNull();
        expect(setupSpy).toHaveBeenCalled();

        // (1) The resolved scroll root must live inside the diff subtree.
        const boundRoots = setupSpy.mock.calls.map((call) => call[0]);
        expect(boundRoots).not.toContain(ancestorRoot);
        expect(setupSpy.mock.calls.at(-1)?.[0]).toBe(nestedRoot);

        // (2) The foreign ancestor's scroll position is byte-identical across provider mount, and no
        // write was even attempted against it.
        expect(ancestorRecorder!.writes).toEqual([]);
        expect(ancestorRecorder!.scrollToCalls).toEqual([]);
        expect(ancestorRoot!.scrollTop).toBe(0);
        expect(ancestorRoot!.scrollLeft).toBe(0);

        // (3) The provider must not replace scroll methods on an element it does not own.
        expect((ancestorRoot as any).scrollTo).toBe(ancestorRecorder!.originalScrollTo);

        await act(async () => {
            root.unmount();
        });
    });

    it('binds virtualization to a nested scroll container without probing or patching it', async () => {
        vi.resetModules();
        setupSpy.mockClear();
        cleanUpSpy.mockClear();

        (globalThis as any).IntersectionObserver = class {};
        (globalThis as any).ResizeObserver = class {};

        const { PierreScrollRootVirtualizerProvider } = await loadDemandedProvider();

        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        let scrollRoot: HTMLDivElement | null = null;
        let recorder: ScrollRecorder | null = null;

        await act(async () => {
            root.render(
                React.createElement(
                    PierreScrollRootVirtualizerProvider,
                    null,
                    React.createElement(
                        'div',
                        null,
                        React.createElement('div', {
                            'data-testid': 'nested-scroll-root',
                            ref: (node: HTMLDivElement | null) => {
                                if (!node || node === scrollRoot) return;
                                scrollRoot = node;
                                node.style.overflowY = 'auto';
                                defineSizeProperty(node, 'clientHeight', 120);
                                defineSizeProperty(node, 'scrollHeight', 560);
                                recorder = instrumentScrollElement(node, { honorsDomScrollToOptions: false });
                            },
                        }, React.createElement('div', { style: { height: '1000px' } })),
                    ),
                ),
            );
        });

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
        });

        expect(scrollRoot).not.toBeNull();
        expect(setupSpy).toHaveBeenCalled();
        const [boundRoot, contentContainer] = setupSpy.mock.calls.at(-1)!;
        expect(boundRoot).toBe(scrollRoot);
        // When the scroll root is an element, we should not pass an external content container.
        // Pierre will infer the correct content container from the scroll root itself.
        expect(contentContainer).toBeUndefined();

        // Binding is observation only: no probe writes, no method replacement, even on our own root.
        expect(recorder!.writes).toEqual([]);
        expect(recorder!.scrollToCalls).toEqual([]);
        expect((scrollRoot as any).scrollTo).toBe(recorder!.originalScrollTo);

        await act(async () => {
            root.unmount();
        });
    });

    it('falls back to document when no nested scroll root exists', async () => {
        vi.resetModules();
        setupSpy.mockClear();
        cleanUpSpy.mockClear();

        (globalThis as any).IntersectionObserver = class {};
        (globalThis as any).ResizeObserver = class {};

        const { PierreScrollRootVirtualizerProvider } = await loadDemandedProvider();

        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        await act(async () => {
            root.render(
                React.createElement(
                    PierreScrollRootVirtualizerProvider,
                    null,
                    React.createElement('div', null, React.createElement('div', null, 'content')),
                ),
            );
        });

        expect(setupSpy).toHaveBeenCalled();
        const [boundRoot] = setupSpy.mock.calls.at(-1)!;
        expect(boundRoot).toBe(document);

        await act(async () => {
            root.unmount();
        });
    });

    it('rebinds from document to nested scroll root when it becomes scrollable later', async () => {
        vi.resetModules();
        setupSpy.mockClear();
        cleanUpSpy.mockClear();

        (globalThis as any).IntersectionObserver = class {};
        (globalThis as any).ResizeObserver = class {};

        const { PierreScrollRootVirtualizerProvider } = await loadDemandedProvider();

        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        let scrollRoot: HTMLDivElement | null = null;

        await act(async () => {
            root.render(
                React.createElement(
                    PierreScrollRootVirtualizerProvider,
                    null,
                    React.createElement(
                        'div',
                        null,
                        React.createElement('div', {
                            ref: (node: HTMLDivElement | null) => {
                                if (!node || node === scrollRoot) return;
                                scrollRoot = node;
                                node.style.overflowY = 'auto';
                                defineSizeProperty(node, 'clientHeight', 120);
                                defineSizeProperty(node, 'scrollHeight', 120);
                            },
                        }),
                    ),
                ),
            );
        });

        expect(scrollRoot).not.toBeNull();
        expect(setupSpy).toHaveBeenCalled();
        const firstRoot = setupSpy.mock.calls[0]?.[0];
        expect(firstRoot).toBe(document);

        defineSizeProperty(scrollRoot!, 'scrollHeight', 580);
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
        });

        const lastRoot = setupSpy.mock.calls.at(-1)?.[0];
        expect(lastRoot).toBe(scrollRoot);
        const lastContentContainer = setupSpy.mock.calls.at(-1)?.[1];
        expect(lastContentContainer).toBeUndefined();

        await act(async () => {
            root.unmount();
        });
    });

    it('keeps diffs connected while still on the document fallback when it rebinds to the nested root', async () => {
        // A diff that mounts before the list's scroller exists connects on the document binding; rebinding
        // clears Pierre's observers, so without a reconnect that diff never learns it is visible (blank).
        vi.resetModules();
        setupSpy.mockClear();
        cleanUpSpy.mockClear();
        connectSpy.mockClear();
        (globalThis as any).IntersectionObserver = class {};
        (globalThis as any).ResizeObserver = class {};
        const { PierreScrollRootVirtualizerProvider, usePierreScrollRootVirtualizer } = await import('./PierreScrollRootVirtualizerProvider.web');
        const { Virtualizer } = await import('@pierre/diffs');
        const early = document.createElement('div');
        const subscriber = { id: 'early-diff' };
        let disconnectEarly: (() => void) | null = null;
        function EarlyDiff() {
            const instance = usePierreScrollRootVirtualizer(() => new Virtualizer());
            React.useEffect(() => {
                disconnectEarly = instance ? instance.connect(early, subscriber as never) : null;
                return () => disconnectEarly?.();
            }, [instance]);
            return null;
        }
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        let scrollRoot: HTMLDivElement | null = null;
        await act(async () => {
            root.render(<PierreScrollRootVirtualizerProvider><EarlyDiff /><div ref={(node) => {
                if (!node || node === scrollRoot) return;
                scrollRoot = node;
                node.style.overflowY = 'auto';
                defineSizeProperty(node, 'clientHeight', 120);
                defineSizeProperty(node, 'scrollHeight', 120);
            }} /></PierreScrollRootVirtualizerProvider>);
        });
        expect(setupSpy.mock.calls[0]?.[0]).toBe(document);
        expect(connectSpy).toHaveBeenCalledTimes(1);
        defineSizeProperty(scrollRoot!, 'scrollHeight', 580);
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
        expect(setupSpy.mock.calls.at(-1)?.[0]).toBe(scrollRoot);
        // Reconnected after the last setup, with the same subscriber.
        expect(connectSpy).toHaveBeenCalledTimes(2);
        expect(connectSpy.mock.calls.at(-1)).toEqual([early, subscriber]);
        expect(connectSpy.mock.invocationCallOrder.at(-1)!).toBeGreaterThan(setupSpy.mock.invocationCallOrder.at(-1)!);
        await act(async () => { root.unmount(); });
    });

    it('connects diffs that mounted before the first bind once it binds', async () => {
        // Leaf diffs connect in their own effects, before the provider's first bind; Pierre queues them,
        // and the bind must not drop that queue.
        vi.resetModules();
        setupSpy.mockClear();
        cleanUpSpy.mockClear();
        connectSpy.mockClear();
        (globalThis as any).IntersectionObserver = class {};
        (globalThis as any).ResizeObserver = class {};
        const { PierreScrollRootVirtualizerProvider, usePierreScrollRootVirtualizer } = await import('./PierreScrollRootVirtualizerProvider.web');
        const { Virtualizer } = await import('@pierre/diffs');
        const leaf = document.createElement('div');
        const subscriber = { id: 'leaf-diff' };
        function Leaf(props: Readonly<{ instance: PierreVirtualizer | undefined }>) {
            React.useEffect(() => props.instance?.connect(leaf, subscriber as never), [props.instance]);
            return null;
        }
        function Diff() {
            const instance = usePierreScrollRootVirtualizer(() => new Virtualizer());
            return <Leaf instance={instance} />;
        }
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        await act(async () => { root.render(<PierreScrollRootVirtualizerProvider><Diff /></PierreScrollRootVirtualizerProvider>); });
        expect(setupSpy).toHaveBeenCalled();
        expect(connectSpy.mock.calls.at(-1)).toEqual([leaf, subscriber]);
        expect(connectSpy.mock.invocationCallOrder.at(-1)!).toBeGreaterThan(setupSpy.mock.invocationCallOrder.at(-1)!);
        await act(async () => { root.unmount(); });
    });

    it('stays on the document fallback rather than adopting an ancestor while the nested root is not yet scrollable', async () => {
        vi.resetModules();
        setupSpy.mockClear();
        cleanUpSpy.mockClear();

        (globalThis as any).IntersectionObserver = class {};
        (globalThis as any).ResizeObserver = class {};

        const { PierreScrollRootVirtualizerProvider } = await loadDemandedProvider();

        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        let ancestorRoot: HTMLDivElement | null = null;
        let nestedRoot: HTMLDivElement | null = null;

        await act(async () => {
            root.render(
                React.createElement(
                    'div',
                    {
                        ref: (node: HTMLDivElement | null) => {
                            if (!node || node === ancestorRoot) return;
                            ancestorRoot = node;
                            node.style.overflowY = 'auto';
                            defineSizeProperty(node, 'clientHeight', 160);
                            defineSizeProperty(node, 'scrollHeight', 560);
                        },
                    },
                    React.createElement(
                        PierreScrollRootVirtualizerProvider,
                        null,
                        React.createElement('div', {
                            ref: (node: HTMLDivElement | null) => {
                                if (!node || node === nestedRoot) return;
                                nestedRoot = node;
                                node.style.overflowY = 'auto';
                                defineSizeProperty(node, 'clientHeight', 160);
                                // Not scrollable at first.
                                defineSizeProperty(node, 'scrollHeight', 120);
                            },
                        }),
                    ),
                ),
            );
        });

        expect(ancestorRoot).not.toBeNull();
        expect(nestedRoot).not.toBeNull();
        expect(setupSpy).toHaveBeenCalled();
        expect(setupSpy.mock.calls.at(-1)?.[0]).toBe(document);

        defineSizeProperty(nestedRoot!, 'scrollHeight', 880);
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
        });

        expect(setupSpy.mock.calls.at(-1)?.[0]).toBe(nestedRoot);
        expect(setupSpy.mock.calls.at(-1)?.[1]).toBeUndefined();
        expect(setupSpy.mock.calls.map((call) => call[0])).not.toContain(ancestorRoot);

        await act(async () => {
            root.unmount();
        });
    });
});
