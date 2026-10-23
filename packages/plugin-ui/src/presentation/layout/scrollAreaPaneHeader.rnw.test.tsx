import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ScrollArea } from '../../components/Layout.js';
import { PluginUiProvider } from '../../components/PluginUiProvider.js';
import { PluginUiPresentationHostProviderInternal, type PluginUiPresentationHost } from '../../presentationHost/context.js';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../../surfaceFixture.testSupport.js';

function scrollTo(element: Element, top: number) {
  act(() => {
    (element as HTMLElement).scrollTop = top;
    element.dispatchEvent(new Event('scroll', { bubbles: false }));
  });
}

describe('a plugin ScrollArea and the containing pane header', () => {
  it('reports only the primary vertical body to the host, and keeps the author\'s own scroll callback', () => {
    // React Native Web emits scroll ticks by elapsed time; each scroll here lands a frame after the last.
    let now = 1_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => (now += 50));
    const reported: number[] = [];
    const tracked: number[] = [];
    const authorScroll = vi.fn();
    const host: PluginUiPresentationHost = {
      paneHeaderScroll: { useReporter: () => (distancePx) => reported.push(distancePx) },
      createScrollActivityTracker: () => ({
        onScroll: (event) => tracked.push(event.nativeEvent.contentOffset.y),
        onLayout: () => {},
        onContentSizeChange: () => {},
      }) as never,
    };
    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <PluginUiPresentationHostProviderInternal host={host}>
          <ScrollArea testID="primary" onScroll={authorScroll}>
            <ScrollArea testID="nested" />
            <ScrollArea testID="row" horizontal />
          </ScrollArea>
        </PluginUiPresentationHostProviderInternal>
      </PluginUiProvider>,
    );
    const primary = mount.container.querySelector('[data-testid="primary"]')!;
    for (const top of [0, 6, 12]) scrollTo(primary, top);
    scrollTo(mount.container.querySelector('[data-testid="nested"]')!, 40);
    scrollTo(mount.container.querySelector('[data-testid="row"]')!, 40);
    expect(reported).toEqual([0, 6, 12]);
    // The host's viewport tracker and the author's own handler still see every primary scroll.
    expect(tracked.slice(0, 3)).toEqual([0, 6, 12]);
    expect(authorScroll).toHaveBeenCalledTimes(3);
    mount.unmount();
    clock.mockRestore();
  });
});
