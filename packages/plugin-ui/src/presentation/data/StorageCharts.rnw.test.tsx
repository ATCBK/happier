import { act, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Treemap, Sunburst, type HappierChartPart } from '@happier-dev/plugin-ui/components';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { SURFACE_CONTEXT_THEME_FIXTURE as theme } from '../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import { placeHappierSunburstLeaders } from './Sunburst.js';

const items: readonly HappierChartPart[] = [
  { key: 'projects', label: 'Projects', value: 600, valueLabel: '600 MB', tone: 'accent', children: [
    { key: 'projects/a', label: 'A', value: 400, valueLabel: '400 MB', tone: 'ink' },
    { key: 'projects/b', label: 'B', value: 200, valueLabel: '200 MB', tone: 'ink' },
  ] },
  { key: 'cache', label: 'Cache', value: 300, valueLabel: '300 MB', tone: 'ink', hatched: true },
];

function StorageChartHost({ kind }: Readonly<{ kind: 'map' | 'rings' }>) {
  const [folder, setFolder] = useState<string | null>(null);
  const [pointed, setPointed] = useState<string | null>(null);
  const [pile, setPile] = useState<readonly string[]>([]);
  const common = { theme, items: folder === 'projects' ? items[0]!.children! : items,
    width: 408, height: 408, accessibilityLabel: `Storage ${folder ?? 'root'}`,
    smallerLabel: (count: number) => `${count} smaller items`, reducedMotion: true, testID: 'storage-chart',
    pointedKey: pointed, onPointAt: setPointed,
    onOpen: (key: string) => { setFolder(key); setPointed(null); },
    onCollect: (key: string) => setPile(previous => [...previous, key]),
    onUp: () => { setFolder(null); setPointed(null); },
  };
  return <>
    {kind === 'map' ? <Treemap {...common} minNodePx={{ width: 56, height: 20 }} />
      : <Sunburst {...common} minArcDegrees={1} centerLabel={folder ?? 'Root'} centerValue={folder ? '600 MB' : '900 MB'}
        upLabel={folder ? 'Root' : undefined} />}
    <output data-testid="pointed">{pointed}</output>
    <output data-testid="pile">{pile.join(',')}</output>
  </>;
}

describe('storage charts through their public component entry', () => {
  it.each(['map', 'rings'] as const)('%s navigates, collects, drills and goes up through real keyboard events', kind => {
    const mount = mountThroughReactNativeWeb(<StorageChartHost kind={kind} />);
    const chart = () => mount.container.querySelector<HTMLElement>('[data-testid="storage-chart"]')!;
    const key = (value: string) => act(() => {
      chart().dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
    });
    const pointed = () => mount.container.querySelector('[data-testid="pointed"]')!.textContent;
    try {
      expect(chart().getAttribute('role')).toBe('img');
      expect(chart().tabIndex).toBe(0);
      expect(chart().getAttribute('aria-label')).toBe('Storage root');
      expect(mount.container.querySelector('svg')).not.toBeNull();
      if (kind === 'map') {
        expect([...mount.container.querySelectorAll('rect')].filter(rect => rect.getAttribute('fill')?.includes('hatch'))).toHaveLength(1);
      } else {
        expect(mount.container.textContent).toContain('Root');
        expect(mount.container.textContent).toContain('900 MB');
      }
      key('ArrowRight');
      expect(pointed()).toBe('projects');
      key(kind === 'map' ? 'ArrowRight' : 'ArrowUp');
      expect(pointed()).toBe('projects/a');
      key('ArrowRight');
      expect(pointed()).toBe('projects/b');
      key(' ');
      expect(mount.container.querySelector('[data-testid="pile"]')!.textContent).toBe('projects/b');
      key('Escape');
      expect(pointed()).toBe('');
      key('ArrowRight');
      key('Enter');
      expect(chart().getAttribute('aria-label')).toBe('Storage projects');
      if (kind === 'rings') expect(mount.container.textContent).toContain('↑ Root');
      key('ArrowRight');
      expect(pointed()).toBe('projects/a');
      key('Backspace');
      expect(chart().getAttribute('aria-label')).toBe('Storage root');
      expect(pointed()).toBe('');
      expect(mount.container.querySelector('[data-testid="pile"]')!.textContent).toBe('projects/b');
    } finally { mount.unmount(); }
  });

  it('names short top-level arcs outside on leaders that never overlap on one side, with the mounted disk in its gap', () => {
    const parts: HappierChartPart[] = [
      { key: 'big', label: 'Development', value: 900, valueLabel: '900 GB', tone: 'ink' },
      ...['Documents', 'iCloud', 'Pictures', '.happier'].map((label, index) => ({ key: label, label, value: 20 + index * 2,
        valueLabel: `${20 + index * 2} GB`, tone: 'ink' as const })),
    ];
    const mount = mountThroughReactNativeWeb(<Sunburst theme={theme} items={parts} width={760} height={408} minArcDegrees={2}
      centerLabel="leeroy" centerValue="311 GB" accessibilityLabel="Rings" smallerLabel={count => `${count} smaller`} gapDegrees={5}
      gapLabel={{ name: 'Work', note: 'another disk' }} testID="rings" />);
    try {
      const text = mount.container.textContent ?? '';
      for (const name of ['Documents  20 GB', 'Pictures  24 GB', 'Work  another disk']) expect(text).toContain(name);
    } finally { mount.unmount(); }
    const placed = placeHappierSunburstLeaders([0.1, 0.11, 0.12, 0.13].map((a, index) => ({ key: `k${index}`, a, ro: 160,
      name: 'x', value: '', quiet: false })), { cx: 380, cy: 204, radius: 178, height: 408 });
    const ys = placed.map(leader => leader.y).sort((a, b) => a - b);
    for (let index = 1; index < ys.length; index++) expect(ys[index]! - ys[index - 1]!).toBeGreaterThanOrEqual(17 - 1e-9);
    expect(placed.every(leader => leader.right)).toBe(true);
  });

  it('drills by morphing arcs by key: mid-way the new level has no settled labels yet, and they arrive when it lands', async () => {
    const mount = mountThroughReactNativeWeb(<Sunburst theme={theme} items={items} width={760} height={408} minArcDegrees={2}
      centerLabel="Root" centerValue="900 MB" accessibilityLabel="Rings" smallerLabel={count => `${count} smaller`} testID="rings" />);
    try {
      await mount.render(<Sunburst theme={theme} items={items[0]!.children!} width={760} height={408} minArcDegrees={2}
        centerLabel="Projects" centerValue="600 MB" upLabel="Root" accessibilityLabel="Rings" smallerLabel={count => `${count} smaller`} testID="rings" />);
      expect(mount.container.querySelectorAll('textPath')).toHaveLength(0);
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
      expect([...mount.container.querySelectorAll('textPath')].map(node => node.textContent)).toContain('A  400 MB');
    } finally { mount.unmount(); }
  });

  it('honours the host reduced motion: the drill lands at once (labels drawn), with no arcs in flight', async () => {
    const mount = mountThroughReactNativeWeb(<Sunburst theme={theme} items={items} width={760} height={408} minArcDegrees={2} reducedMotion
      centerLabel="Root" centerValue="900 MB" accessibilityLabel="Rings" smallerLabel={count => `${count} smaller`} testID="rings" />);
    try {
      await mount.render(<Sunburst theme={theme} items={items[0]!.children!} width={760} height={408} minArcDegrees={2} reducedMotion
        centerLabel="Projects" centerValue="600 MB" upLabel="Root" accessibilityLabel="Rings" smallerLabel={count => `${count} smaller`} testID="rings" />);
      expect([...mount.container.querySelectorAll('textPath')].map(node => node.textContent)).toContain('A  400 MB');
    } finally { mount.unmount(); }
  });
});
