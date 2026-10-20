import { act, type ComponentType } from 'react';
import { describe, expect, it } from 'vitest';

import * as PluginUi from '@happier-dev/plugin-ui/components';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import {
  createHostApiStub,
  createSurfaceContext,
} from '../surfaceFixture.testSupport.js';
import { PluginUiProviderInternal } from './PluginUiProvider.js';

type TechnicalDetailsProps = Readonly<{
  title: string;
  lines: readonly Readonly<{ key: string; label: string; value: string }>[];
  testID?: string;
}>;

/** Whether the rendered element's own style (inline or its RNW class rules) balances its wrapping. */
function balancesWrapping(element: Element): boolean {
  const inline = element.getAttribute('style') ?? '';
  if (/text-wrap:\s*balance/.test(inline)) return true;
  const classes = new Set(Array.from(element.classList));
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      const text = rule.cssText;
      if (!/text-wrap:\s*balance/.test(text)) continue;
      const selector = (rule as CSSStyleRule).selectorText ?? '';
      if (Array.from(classes).some((name) => selector.includes(`.${name}`)))
        return true;
    }
  }
  return false;
}

describe('public TechnicalDetailsDisclosure', () => {
  it('folds exact references behind one row, opens them as label + selectable value, and draws nothing without lines', async () => {
    // A missing public component renders no row: the external-author gap this export closes.
    const TechnicalDetails = (
      PluginUi as typeof PluginUi & {
        TechnicalDetailsDisclosure?: ComponentType<TechnicalDetailsProps>;
      }
    ).TechnicalDetailsDisclosure;
    const context = createSurfaceContext();
    const hostApi = createHostApiStub(context);
    const lines = [
      { key: 'code', label: 'Failure code', value: 'storage_unavailable' },
      { key: 'run', label: 'Run id', value: 'run_7f3a9c' },
    ];
    const surface = (shown: TechnicalDetailsProps['lines']) => (
      <PluginUiProviderInternal context={context} hostApi={hostApi}>
        {TechnicalDetails ? (
          <TechnicalDetails
            title="Technical details"
            lines={shown}
            testID="tech"
          />
        ) : null}
      </PluginUiProviderInternal>
    );
    const view = mountThroughReactNativeWeb(surface(lines));
    try {
      const header = () =>
        view.container.querySelector<HTMLElement>(
          '[data-testid="tech.header"] [role="button"], [data-testid="tech.header"][role="button"]',
        );
      expect(
        header(),
        'authors can render the technical details row through the public entry point',
      ).not.toBeNull();
      expect(header()?.textContent).toContain('Technical details');
      expect(header()?.getAttribute('aria-expanded')).toBe('false');
      expect(view.container.textContent).not.toContain('storage_unavailable');

      act(() => header()!.click());
      expect(header()?.getAttribute('aria-expanded')).toBe('true');
      expect(view.container.textContent).toContain('Failure code');
      expect(view.container.textContent).toContain('storage_unavailable');
      expect(view.container.textContent).toContain('run_7f3a9c');

      await view.render(surface([]));
      expect(header()).toBeNull();
      expect(view.container.textContent).toBe('');
    } finally {
      view.unmount();
    }
  });
});

describe('balanced wrapping in shared centred and capsule copy', () => {
  it('splits a plugin state title and description evenly on the web', () => {
    const context = createSurfaceContext();
    const view = mountThroughReactNativeWeb(
      <PluginUiProviderInternal
        context={context}
        hostApi={createHostApiStub(context)}
      >
        <PluginUi.EmptyState
          title="Opening primary on NLDW4-5-40-40"
          description="The window opens once the Machine answers."
        />
      </PluginUiProviderInternal>,
    );
    try {
      const title = Array.from(view.container.querySelectorAll('*')).find(
        (node) =>
          node.childElementCount === 0 &&
          node.textContent === 'Opening primary on NLDW4-5-40-40',
      );
      const description = Array.from(view.container.querySelectorAll('*')).find(
        (node) =>
          node.childElementCount === 0 &&
          node.textContent === 'The window opens once the Machine answers.',
      );
      expect(title).toBeDefined();
      expect(description).toBeDefined();
      expect(balancesWrapping(title!)).toBe(true);
      expect(balancesWrapping(description!)).toBe(true);
    } finally {
      view.unmount();
    }
  });
});
