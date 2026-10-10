import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../../surfaceFixture.testSupport.js';
import { Banner } from '../../components/index.js';
import { PluginUiProvider } from '../../components/PluginUiProvider.js';
import { splitHappierBannerPoint } from './Foundation.js';

describe('banner points', () => {
  it("lists an author's checks as hanging lines under the description, with literal commands kept whole as code", () => {
    const commands = ['brew install lima', 'limactl start'];
    expect(splitHappierBannerPoint('Run brew install lima, then limactl start', commands))
      .toEqual(['Run ', { code: 'brew install lima' }, ', then ', { code: 'limactl start' }]);
    expect(splitHappierBannerPoint('Make sure Lima is on your PATH', commands)).toEqual(['Make sure Lima is on your PATH']);

    const context = createSurfaceContext();
    const view = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <Banner testID="lima" tone="warning" title="Lima is not installed" description="Install it to create local machines."
          points={[splitHappierBannerPoint('Run brew install lima, then limactl start', commands),
            splitHappierBannerPoint('Make sure Lima is on your PATH', commands)]} />
      </PluginUiProvider>,
    );
    try {
      const point = (index: number) => view.container.querySelector<HTMLElement>(`[data-testid="lima.point.${index}"]`);
      expect(point(0)?.textContent).toBe('•Run brew install lima, then limactl start');
      expect(point(1)?.textContent).toBe('•Make sure Lima is on your PATH');
      // The bullet hangs: it is decoration, not part of the line a screen reader reads.
      expect(point(0)?.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
      expect(view.container.textContent).toContain('Install it to create local machines.');
    } finally { view.unmount(); }
  });
});
