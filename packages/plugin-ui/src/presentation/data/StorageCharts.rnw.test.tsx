import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { SURFACE_CONTEXT_THEME_FIXTURE } from '../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { placeHappierSunburstLeaders, Sunburst } from './Sunburst.js';
import { Treemap, type HappierChartPart } from './Treemap.js';

const theme = SURFACE_CONTEXT_THEME_FIXTURE;
const ITEMS: HappierChartPart[] = [
  {
    key: '/u/dev',
    label: 'Development',
    value: 148,
    valueLabel: '148 GB',
    tone: 'ink',
    children: [
      {
        key: '/u/dev/happier',
        label: 'happier',
        value: 96,
        valueLabel: '96 GB',
        tone: 'accent',
      },
      {
        key: '/u/dev/web',
        label: 'website',
        value: 21,
        valueLabel: '21 GB',
        tone: 'ink',
      },
    ],
  },
  {
    key: '/u/lib',
    label: 'Library',
    value: 64,
    valueLabel: '64 GB',
    tone: 'ink',
    hatched: true,
  },
  {
    key: '/u/mov',
    label: 'Movies',
    value: 41,
    valueLabel: '41 GB',
    tone: 'ink',
    locked: true,
  },
];

function press(element: Element, key: string) {
  act(() => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

describe('storage chart owners (Map and Rings) through React Native Web', () => {
  it('draws one labelled picture of the level, with the pile as an overlay and the keyboard model of the list beneath', () => {
    const onOpen = vi.fn();
    const onCollect = vi.fn();
    const onUp = vi.fn();
    const mount = mountThroughReactNativeWeb(
      <Treemap
        theme={theme}
        items={ITEMS}
        width={760}
        height={300}
        minNodePx={{ width: 56, height: 20 }}
        accessibilityLabel="Map of leeroy"
        smallerLabel={(count) => `${count} smaller`}
        onOpen={onOpen}
        onCollect={onCollect}
        onUp={onUp}
        testID="map"
      />,
    );
    try {
      const chart = mount.container.querySelector('[data-testid="map"]')!;
      expect(chart.getAttribute('aria-label')).toBe('Map of leeroy');
      expect(mount.container.textContent).toContain('Development');
      expect(mount.container.textContent).toContain('148 GB');
      // The collected part carries the hatch overlay; nothing else does.
      const hatchFills = [...mount.container.querySelectorAll('rect')].filter(
        (rect) => (rect.getAttribute('fill') ?? '').includes('hatch'),
      );
      expect(hatchFills.length).toBe(1);
      press(chart, 'ArrowRight');
      press(chart, 'Enter');
      expect(onOpen).toHaveBeenCalledWith('/u/dev');
      press(chart, 'ArrowRight');
      press(chart, ' ');
      expect(onCollect).toHaveBeenCalledTimes(1);
      press(chart, 'Backspace');
      expect(onUp).toHaveBeenCalledTimes(1);
    } finally {
      mount.unmount();
    }
  });

  it('draws Rings with the folder in the centre and the way up, moving along a ring and out to its children by keyboard', () => {
    const onOpen = vi.fn();
    const onUp = vi.fn();
    const mount = mountThroughReactNativeWeb(
      <Sunburst
        theme={theme}
        items={ITEMS}
        width={760}
        height={408}
        minArcDegrees={2}
        centerLabel="leeroy"
        centerValue="311 GB"
        upLabel="Users"
        accessibilityLabel="Rings of leeroy"
        smallerLabel={(count) => `${count} smaller`}
        onOpen={onOpen}
        onUp={onUp}
        testID="rings"
      />,
    );
    try {
      const chart = mount.container.querySelector('[data-testid="rings"]')!;
      expect(chart.getAttribute('aria-label')).toBe('Rings of leeroy');
      expect(mount.container.textContent).toContain('leeroy');
      expect(mount.container.textContent).toContain('311 GB');
      expect(mount.container.textContent).toContain('↑ Users');
      press(chart, 'ArrowRight');
      press(chart, 'ArrowUp');
      press(chart, 'Enter');
      expect(onOpen).toHaveBeenCalledWith('/u/dev/happier');
      press(chart, 'Escape');
      expect(onUp).toHaveBeenCalledTimes(1);
    } finally {
      mount.unmount();
    }
  });

  it('names short top-level arcs outside on leaders that never overlap on one side, with the mounted disk in its gap', () => {
    const items: HappierChartPart[] = [
      { key: 'big', label: 'Development', value: 900, valueLabel: '900 GB', tone: 'ink' },
      ...['Documents', 'iCloud', 'Pictures', '.happier'].map((label, index) => ({ key: label, label, value: 20 + index * 2, valueLabel: `${20 + index * 2} GB`, tone: 'ink' as const })),
    ];
    const mount = mountThroughReactNativeWeb(<Sunburst theme={theme} items={items} width={760} height={408} minArcDegrees={2}
      centerLabel="leeroy" centerValue="311 GB" accessibilityLabel="Rings" smallerLabel={count => `${count} smaller`} gapDegrees={5}
      gapLabel={{ name: 'Work', note: 'another disk' }} testID="rings" />);
    try {
      const text = mount.container.textContent ?? '';
      for (const name of ['Documents  20 GB', 'Pictures  24 GB', 'Work  another disk']) expect(text).toContain(name);
    } finally { mount.unmount(); }
    const placed = placeHappierSunburstLeaders([0.1, 0.11, 0.12, 0.13].map((a, index) => ({ key: `k${index}`, a, ro: 160, name: 'x', value: '', quiet: false })),
      { cx: 380, cy: 204, radius: 178, height: 408 });
    const ys = placed.map(leader => leader.y).sort((a, b) => a - b);
    for (let index = 1; index < ys.length; index++) expect(ys[index]! - ys[index - 1]!).toBeGreaterThanOrEqual(17 - 1e-9);
    expect(placed.every(leader => leader.right)).toBe(true);
  });

  it('drills by morphing arcs by key: mid-way the new level has no settled labels yet, and they arrive when it lands', async () => {
    const mount = mountThroughReactNativeWeb(<Sunburst theme={theme} items={ITEMS} width={760} height={408} minArcDegrees={2}
      centerLabel="leeroy" centerValue="311 GB" accessibilityLabel="Rings" smallerLabel={count => `${count} smaller`} testID="rings" />);
    try {
      const drilled = ITEMS[0]!.children!;
      await mount.render(<Sunburst theme={theme} items={drilled} width={760} height={408} minArcDegrees={2}
        centerLabel="Development" centerValue="148 GB" upLabel="leeroy" accessibilityLabel="Rings" smallerLabel={count => `${count} smaller`} testID="rings" />);
      // In flight: arcs are moving, so no curved label is drawn yet (a cross-fade would show them at once).
      expect(mount.container.querySelectorAll('textPath').length).toBe(0);
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
      expect([...mount.container.querySelectorAll('textPath')].map(node => node.textContent)).toContain('happier  96 GB');
    } finally { mount.unmount(); }
  });

  it('honours the host reduced motion: the drill lands at once (labels drawn), with no arcs in flight', async () => {
    const mount = mountThroughReactNativeWeb(<Sunburst theme={theme} items={ITEMS} width={760} height={408} minArcDegrees={2} reducedMotion
      centerLabel="leeroy" centerValue="311 GB" accessibilityLabel="Rings" smallerLabel={count => `${count} smaller`} testID="rings" />);
    try {
      await mount.render(<Sunburst theme={theme} items={ITEMS[0]!.children!} width={760} height={408} minArcDegrees={2} reducedMotion
        centerLabel="Development" centerValue="148 GB" upLabel="leeroy" accessibilityLabel="Rings" smallerLabel={count => `${count} smaller`} testID="rings" />);
      expect([...mount.container.querySelectorAll('textPath')].map(node => node.textContent)).toContain('happier  96 GB');
    } finally { mount.unmount(); }
  });
});
