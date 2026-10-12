/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { installPopoverCommonModuleMocks } from '@/components/ui/popover/popoverTestHelpers';

installPopoverCommonModuleMocks({ reactNative: async () => ({
    ...await vi.importActual('react-native-web'),
    useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
}) });
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Keep cold module collection outside the observable placement deadline.
const { CommandMenu } = await import('../CommandMenu');
const { PopoverPortalTargetProvider } = await import('@/components/ui/popover/PopoverPortalTargetProvider');

describe('composer menu placement on phone web', () => {
    it.each(['ancestor scroll', 'window resize', 'visual viewport resize', 'anchor layout', 'ancestor layout', 'focus'] as const)(
        'keeps the top-only picker above the input after %s', async (change) => {
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        const visualViewport = new EventTarget();
        vi.stubGlobal('visualViewport', visualViewport);
        // jsdom has no layout engine: expose browser layout notifications at that boundary.
        const observers = new Set<{ elements: Set<Element>; notify: () => void }>();
        vi.stubGlobal('ResizeObserver', class {
            elements = new Set<Element>();
            constructor(private callback: () => void) { observers.add(this); }
            observe(element: Element) { this.elements.add(element); }
            unobserve(element: Element) { this.elements.delete(element); }
            disconnect() { observers.delete(this); }
            notify() { this.callback(); }
        });
        let anchorTop = 403;
        const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
            const top = this.getAttribute('data-testid') === 'composer-anchor' ? anchorTop : 0;
            const height = this.getAttribute('data-testid') === 'composer-anchor' ? 65
                : this.hasAttribute('data-happy-popover-portal-host') ? 0 : 380;
            return { x: 0, y: top, left: 0, top, right: 390, bottom: top + height, width: 390, height, toJSON: () => ({}) };
        });
        function Harness() {
            const anchorRef = React.useRef<HTMLDivElement>(null);
            return <div data-testid="home-scroll">
                <PopoverPortalTargetProvider>
                    <div ref={anchorRef} data-testid="composer-anchor" />
                    <CommandMenu open anchor={{ kind: 'view', ref: anchorRef }} boundaryRef={null}
                        placement="top" flip={false} fillHeight maxHeight={380} query="" items={[]} selectedIndex={-1}
                        onMoveUp={() => {}} onMoveDown={() => {}} onSelect={() => {}} onRequestClose={() => {}} testID="picker" />
                </PopoverPortalTargetProvider>
            </div>;
        }
        const pickerBottom = () => {
            let node = document.querySelector<HTMLElement>('[data-testid="picker:surface"]');
            while (node && !node.style.bottom) node = node.parentElement;
            expect(node).not.toBeNull();
            // The provider's web host has zero height: negative bottom pins its edge below the origin.
            return -Number.parseFloat(node!.style.bottom);
        };
        try {
            await act(async () => root.render(<Harness />));
            await vi.waitFor(() => expect(pickerBottom()).toBe(399));
            anchorTop = 357;
            await act(async () => {
                const ancestor = container.querySelector('[data-testid="home-scroll"]')!;
                const anchor = container.querySelector('[data-testid="composer-anchor"]')!;
                if (change === 'ancestor scroll') ancestor.dispatchEvent(new Event('scroll', { bubbles: false }));
                if (change === 'window resize') window.dispatchEvent(new Event('resize'));
                if (change === 'visual viewport resize') visualViewport.dispatchEvent(new Event('resize'));
                if (change === 'anchor layout' || change === 'ancestor layout') {
                    const element = change === 'anchor layout' ? anchor : ancestor;
                    for (const observer of observers) if (observer.elements.has(element)) observer.notify();
                }
                if (change === 'focus') anchor.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
            });
            await vi.waitFor(() => expect(pickerBottom()).toBeLessThanOrEqual(anchorTop));
        } finally {
            await act(async () => root.unmount());
            measure.mockRestore();
            container.remove();
            vi.unstubAllGlobals();
            expect([...observers].every(observer => observer.elements.size === 0)).toBe(true);
        }
    });
});
