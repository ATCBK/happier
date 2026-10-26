/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { installPopoverCommonModuleMocks } from '@/components/ui/popover/popoverTestHelpers';

installPopoverCommonModuleMocks({
  reactNative: async () => {
    const native = await vi.importActual<typeof import('react-native')>('react-native-web');
    const dimensions = () => ({
      width: 1440,
      height: 1000,
      scale: 1,
      fontScale: 1,
    });
    return {
      ...native,
      useWindowDimensions: dimensions,
      Dimensions: {
        get: dimensions,
        addEventListener: native.Dimensions.addEventListener.bind(native.Dimensions),
      },
    };
  },
});
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const { CommandMenu } = await import('../CommandMenu');
const { PopoverPortalTargetProvider } =
  await import('@/components/ui/popover/PopoverPortalTargetProvider');

describe('composer menu clearance on web', () => {
  it('stays above the composer when the composer moves without the caret moving', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    // jsdom has no layout engine: expose browser layout notifications at that boundary.
    const observers = new Set<{ elements: Set<Element>; notify: () => void }>();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        elements = new Set<Element>();
        constructor(private callback: () => void) {
          observers.add(this);
        }
        observe(element: Element) {
          this.elements.add(element);
        }
        unobserve(element: Element) {
          this.elements.delete(element);
        }
        disconnect() {
          observers.delete(this);
        }
        notify() {
          this.callback();
        }
      },
    );
    let composerTop = 800;
    const measure = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const composer = this.getAttribute('data-testid') === 'composer';
        const top = composer ? composerTop : 0;
        const height = composer
          ? 160
          : this.hasAttribute('data-happy-popover-portal-host')
            ? 0
            : 240;
        return {
          x: 0,
          y: top,
          left: 0,
          top,
          right: 1440,
          bottom: top + height,
          width: 1440,
          height,
          toJSON: () => ({}),
        };
      });
    function Harness() {
      const composerRef = React.useRef<HTMLDivElement>(null);
      return (
        <div data-testid="session-pane">
          <PopoverPortalTargetProvider>
            <div ref={composerRef} data-testid="composer" />
            {/* The caret rect is captured once and is not updated by the composer's reflow. */}
            <CommandMenu
              open
              anchor={{
                kind: 'rect',
                rect: { left: 40, top: 840, height: 20 },
              }}
              clearanceRef={composerRef}
              boundaryRef={null}
              placement="top"
              flip={false}
              maxHeight={240}
              query=""
              items={[]}
              selectedIndex={-1}
              onMoveUp={() => {}}
              onMoveDown={() => {}}
              onSelect={() => {}}
              onRequestClose={() => {}}
              testID="picker"
            />
          </PopoverPortalTargetProvider>
        </div>
      );
    }
    const pickerBottom = () => {
      let node = document.querySelector<HTMLElement>(
        '[data-testid="picker:surface"]',
      );
      while (node && !node.style.bottom) node = node.parentElement;
      expect(node).not.toBeNull();
      return -Number.parseFloat(node!.style.bottom);
    };
    try {
      await act(async () => root.render(<Harness />));
      // The menu's bottom stands the menu gap (4) above the composer, not above the caret (840).
      await vi.waitFor(() => expect(pickerBottom()).toBe(796));
      composerTop = 500;
      await act(async () => {
        const pane = container.querySelector('[data-testid="session-pane"]')!;
        for (const observer of observers)
          if (observer.elements.has(pane)) observer.notify();
      });
      await vi.waitFor(() => expect(pickerBottom()).toBe(496));
    } finally {
      await act(async () => root.unmount());
      measure.mockRestore();
      container.remove();
      vi.unstubAllGlobals();
    }
  });
});
