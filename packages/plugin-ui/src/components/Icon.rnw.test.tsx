import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { Button } from './Button.js';
import { Icon } from './Icon.js';
import { PluginUiProvider, PluginUiProviderInternal } from './PluginUiProvider.js';
import type { PluginUiPresentationHost } from '../presentationHost/context.js';

describe('portable semantic Icon', () => {
  it('uses a closed semantic name and preserves decorative versus named accessibility', () => {
    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <Icon name="search" accessibilityLabel="Search" testID="search-icon" />
        <Icon name="check" testID="decorative-icon" />
      </PluginUiProvider>,
    );

    expect(mount.container.querySelector('[aria-label="Search"]')).not.toBeNull();
    expect(mount.container.querySelector('[data-testid="decorative-icon"]')?.getAttribute('aria-hidden')).toBe('true');
    mount.unmount();
  });

  it('inks a leading glyph in its button\'s own foreground, so a filled primary never hides it', () => {
    const host: PluginUiPresentationHost = {
      renderIcon: ({ color, testID }) => <span data-testid={testID} style={{ color }} />,
      renderMarkdown: () => null,
      renderCodeBlock: () => null,
      renderPopover: () => null,
    };
    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(
      <PluginUiProviderInternal hostApi={createHostApiStub(context)} context={context} presentationHost={host}>
        <Button variant="primary" title="Publish" icon={<Icon name="send" testID="glyph" />} onPress={() => undefined} />
        <Button variant="primary" title="Alert" icon={<Icon name="send" tone="danger" testID="toned" />} onPress={() => undefined} />
      </PluginUiProviderInternal>,
    );
    const colorOf = (element: Element | null) => getComputedStyle(element!).color;
    const label = [...mount.container.querySelectorAll('*')].find(node => node.children.length === 0 && node.textContent === 'Publish');
    expect(colorOf(mount.container.querySelector('[data-testid="glyph"]'))).toBe(colorOf(label ?? null));
    expect(colorOf(mount.container.querySelector('[data-testid="toned"]'))).not.toBe(colorOf(label ?? null));
    mount.unmount();
  });
});
