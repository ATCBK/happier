import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import {
  createHostApiStub,
  createSurfaceContext,
} from '../surfaceFixture.testSupport.js';
import { AnsiText } from './AnsiText.js';
import { CheckStatusGlyph } from './CheckStatusGlyph.js';
import { PluginUiProvider } from './PluginUiProvider.js';

function rgb(hex: string): string {
  const value = parseInt(hex.slice(1), 16);
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
}

describe('AnsiText', () => {
  it('draws standard terminal colours in the theme inks, never as markup, and marks Find ranges on the plain text', () => {
    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <AnsiText
          testID="log"
          text={'\u001b[31mError:\u001b[0m <b>boom</b>'}
          ranges={[{ start: 7, end: 10, current: true }]}
        />
      </PluginUiProvider>,
    );
    const root = mount.container.querySelector('[data-testid="log"]')!;
    expect(root.textContent).toBe('Error: <b>boom</b>');
    expect(root.querySelector('b')).toBeNull();
    const error = Array.from(root.querySelectorAll('span, div')).find(
      (node) => node.textContent === 'Error:',
    ) as HTMLElement | undefined;
    expect(error?.style.color).toBe(rgb(context.theme.colors.danger));
    expect(
      root.querySelector('[data-testid="find-match-current"]')?.textContent,
    ).toBe('<b>');
    mount.unmount();
  });
});

describe('CheckStatusGlyph', () => {
  it('names its state only when asked and draws a glyph for settled states', () => {
    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <CheckStatusGlyph
          status="failed"
          accessibilityLabel="Failed"
          testID="failed"
        />
        <CheckStatusGlyph status="passed" testID="passed" />
        <CheckStatusGlyph status="running" testID="running" />
      </PluginUiProvider>,
    );
    expect(
      mount.container.querySelector('[aria-label="Failed"]'),
    ).not.toBeNull();
    expect(
      mount.container
        .querySelector('[data-testid="passed"]')
        ?.getAttribute('aria-hidden'),
    ).toBe('true');
    expect(
      mount.container.querySelector('[data-testid="failed"] svg'),
    ).not.toBeNull();
    mount.unmount();
  });
});
