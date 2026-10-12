import { describe, expect, it } from 'vitest';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { SURFACE_CONTEXT_THEME_FIXTURE as theme } from '../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import { CoreLoadBars, type CoreLoadBar } from './CoreLoadBars.js';

const cores: readonly CoreLoadBar[] = [
  { index: 0, busyPct: 12, cluster: 'e' }, { index: 1, busyPct: 42, cluster: 'p' },
  { index: 2, busyPct: null, cluster: 'p' }, { index: 3, busyPct: 0, cluster: 'e' },
];
const coreLabel = (core: CoreLoadBar) => `Core ${core.index + 1}, ${core.cluster === 'p' ? 'performance' : 'efficiency'}, ${core.busyPct === null ? 'not reported' : `${core.busyPct}%`}`;
describe('per-core load', () => {
  it('orders performance before efficiency, wraps to the measured row width, and exposes every core', async () => {
    const render = (width: number) => <CoreLoadBars theme={theme} label="CPU cores" cores={cores} width={width}
      coreLabel={coreLabel} legend={{ p: '2 performance', e: '2 efficiency' }} testID="cores" />;
    const mount = mountThroughReactNativeWeb(render(40));
    try {
      const labels = [...mount.container.querySelectorAll('[data-testid^="cores-core-"]')].map((core) => core.getAttribute('aria-label'));
      expect(labels).toEqual([coreLabel(cores[1]!), coreLabel(cores[2]!), coreLabel(cores[0]!), coreLabel(cores[3]!)]);
      const rows = () => [...mount.container.querySelectorAll('[data-testid^="cores-row-"]')].filter((row) => /^cores-row-\d+$/u.test(row.getAttribute('data-testid')!));
      expect(rows()).toHaveLength(2);
      const busy = mount.container.querySelector<HTMLElement>('[data-testid="cores-row-0-bar-0-0"]')!;
      const zero = mount.container.querySelector<HTMLElement>('[data-testid="cores-row-1-bar-1-0"]')!;
      expect(Number.parseFloat(busy.style.height)).toBeCloseTo(13.44);
      expect(Number.parseFloat(zero.style.height)).toBeGreaterThan(0);
      expect(mount.container.querySelector('[data-testid="cores-row-0-bar-1-0"]')).toBeNull();
      expect(mount.container.textContent).toContain('2 performance');
      await mount.render(render(200));
      expect(rows()).toHaveLength(1);
      expect([...mount.container.querySelectorAll('[data-testid^="cores-core-"]')].map((core) => core.getAttribute('aria-label'))).toEqual(labels);
    } finally { mount.unmount(); }
  });
});
