import * as React from 'react';
import { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The native renderer is the system boundary; grid, platform facts and target sizing remain real.
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: <T,>(options: Readonly<{ ios?: T; native?: T; default?: T }>) => options.ios ?? options.native ?? options.default },
  I18nManager: { isRTL: false },
  Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', View: 'View',
  StyleSheet: { hairlineWidth: 1, create: <T extends Record<string, unknown>>(styles: T) => styles, flatten: (style: unknown) => flattenStyle(style) },
}));

import { SURFACE_CONTEXT_THEME_FIXTURE } from '../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import { HappierUiPlatformProvider } from '../../environment/context.js';
import { Heatmap, type HappierGridFrame } from './Heatmap.js';

function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
  return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

function physicalStyle(style: unknown) {
  return flattenStyle(typeof style === 'function' ? style({ pressed: false, hovered: false, focused: false, selected: false, busy: false, disabled: false }) : style);
}

const grid = {
  theme: SURFACE_CONTEXT_THEME_FIXTURE,
  label: 'Measurements', unknownLabel: 'Unknown', testID: 'measurements',
  rows: [{ id: 'sample', label: 'Sample' }],
  columns: [{ id: 'first', label: 'First' }, { id: 'second', label: 'Second' }],
  cells: [
    { id: 'zero', row: 'sample', column: 'first', label: 'Zero sample', value: 0 },
    { id: 'unknown', row: 'sample', column: 'second', label: 'Missing sample', value: null },
  ],
} as const;

let renderer: ReactTestRenderer | null = null;
afterEach(() => { act(() => renderer?.unmount()); renderer = null; });

describe('native grid target geometry', () => {
  for (const platform of ['ios', 'android'] as const) {
    it(`keeps the ${platform} grid at its drawn geometry and reaches the target only into the gaps`, () => {
      const frames: HappierGridFrame[] = [];
      act(() => {
        renderer = create(<HappierUiPlatformProvider platform={{ platform, colorScheme: 'dark' }}>
          <Heatmap {...grid} renderFrame={frame => { frames.push(frame); return frame.renderContent(0); }} />
        </HappierUiPlatformProvider>);
      });
      const controls = renderer!.root.findAllByType('Pressable');
      expect(controls.map(control => control.props.accessibilityLabel)).toEqual(['Zero sample: 0', 'Missing sample: Unknown']);
      const style = physicalStyle(controls[0].props.style);
      // A touch target is a hit area: the cell keeps its 11 px slot and 3 px gap, and its hit area
      // reaches half the gap on each side so neighbouring cells never share a touch.
      expect(style).toMatchObject({ width: 11, height: 11 });
      expect(style.minWidth).toBeUndefined();
      expect(style.minHeight).toBeUndefined();
      expect(controls[0].props.hitSlop).toEqual({ top: 1.5, bottom: 1.5, left: 1.5, right: 1.5 });
      expect(frames[0].columnStride).toBe(14);
      expect(renderer!.root.findAllByType('ScrollView')).toHaveLength(0);
      const marks = controls[0].findAllByType('View').filter(view => flattenStyle(view.props.style).backgroundColor);
      expect(flattenStyle(marks[0].props.style)).toMatchObject({ height: 11 });
    });
  }

  it('owns native overflow only when the caller has not supplied a frame, retaining exact selectable values', () => {
    act(() => { renderer = create(<HappierUiPlatformProvider platform={{ platform: 'android', colorScheme: 'dark' }}><Heatmap {...grid} /></HappierUiPlatformProvider>); });
    const scroll = renderer!.root.findAllByType('ScrollView');
    expect(scroll).toHaveLength(1);
    expect(scroll[0].props.horizontal).toBe(true);
    const controls = renderer!.root.findAllByType('Pressable');
    act(() => controls[1].props.onPress());
    expect(renderer!.root.findAllByType('Text').some(node => node.props.children === 'Missing sample: Unknown')).toBe(true);
    act(() => renderer!.update(<HappierUiPlatformProvider platform={{ platform: 'android', colorScheme: 'dark' }}><Heatmap {...grid} size="tile" cells={[...grid.cells].reverse()} /></HappierUiPlatformProvider>));
    expect(renderer!.root.findAllByType('Text').some(node => node.props.children === 'Missing sample: Unknown')).toBe(true);
  });

  it('leaves caller-owned controls and decorative marks at their incumbent dense geometry', () => {
    const frames: HappierGridFrame[] = [];
    act(() => { renderer = create(<HappierUiPlatformProvider platform={{ platform: 'android', colorScheme: 'dark' }}>
      <Heatmap {...grid} renderCell={(_cell, visual) => visual} renderFrame={frame => { frames.push(frame); return frame.renderContent(0); }} />
    </HappierUiPlatformProvider>); });
    expect(frames[0].columnStride).toBe(14);
    expect(frames[0].contentWidth).toBe(28);
    expect(renderer!.root.findAllByType('Pressable')).toHaveLength(0);
    expect(renderer!.root.findAllByType('ScrollView')).toHaveLength(0);
    act(() => renderer!.update(<HappierUiPlatformProvider platform={{ platform: 'android', colorScheme: 'dark' }}><Heatmap {...grid} decorative /></HappierUiPlatformProvider>));
    expect(renderer!.root.findAllByType('Pressable')).toHaveLength(0);
    expect(renderer!.root.findAllByType('ScrollView')).toHaveLength(0);
  });
});
