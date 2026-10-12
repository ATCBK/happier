import { act, useEffect, type ComponentType, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import * as PluginUi from '@happier-dev/plugin-ui/components';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProviderInternal } from './PluginUiProvider.js';

type CountedRowProps = Readonly<{
  title: string;
  count?: number;
  subtitle?: string;
  testID?: string;
  children: ReactNode;
}>;

describe('public CountedDisclosureItem', () => {
  it('keeps quiet details unmounted until opened, updates its count without folding, and supports a word summary', async () => {
    // A missing public component renders no row, giving the intended authoring-gap RED.
    const CountedRow = (PluginUi as typeof PluginUi & {
      CountedDisclosureItem?: ComponentType<CountedRowProps>;
    }).CountedDisclosureItem;
    const context = createSurfaceContext();
    const hostApi = createHostApiStub(context);
    let detailsMounted = false;
    function Details() {
      useEffect(() => {
        detailsMounted = true;
        return () => { detailsMounted = false; };
      }, []);
      return <PluginUi.Text testID="offline-details" value="Laptop · last seen yesterday" />;
    }
    const surface = (count?: number, subtitle?: string) => (
      <PluginUiProviderInternal context={context} hostApi={hostApi}>
        {CountedRow ? (
          <CountedRow title="Offline" count={count} subtitle={subtitle} testID="offline">
            <Details />
          </CountedRow>
        ) : null}
      </PluginUiProviderInternal>
    );
    const view = mountThroughReactNativeWeb(surface(77));
    try {
      const header = () => view.container.querySelector<HTMLElement>('[data-testid="offline.header"] [role="button"], [data-testid="offline.header"][role="button"]');
      expect(header(), 'authors can render the counted disclosure through the public entry point').not.toBeNull();
      expect(header()?.getAttribute('aria-expanded')).toBe('false');
      expect(header()?.textContent).toContain('77');
      expect(detailsMounted).toBe(false);

      act(() => header()!.click());
      expect(header()?.getAttribute('aria-expanded')).toBe('true');
      expect(detailsMounted).toBe(true);
      expect(view.container.querySelector('[data-testid="offline-details"]')).not.toBeNull();
      await view.render(surface(78));
      expect(header()?.textContent).toContain('78');
      expect(header()?.getAttribute('aria-expanded')).toBe('true');

      act(() => header()!.click());
      expect(header()?.getAttribute('aria-expanded')).toBe('false');
      expect(detailsMounted).toBe(false);
      await view.render(surface(undefined, 'Every agent uses the account default'));
      expect(header()?.textContent).toContain('Every agent uses the account default');
      expect(header()?.textContent).not.toContain('78');
      act(() => header()!.click());
      expect(detailsMounted).toBe(true);
      await view.render(surface(0));
      expect(header()?.textContent).toContain('0');
      expect(header()?.getAttribute('aria-expanded')).toBe('true');
    } finally {
      view.unmount();
    }
  });
});
