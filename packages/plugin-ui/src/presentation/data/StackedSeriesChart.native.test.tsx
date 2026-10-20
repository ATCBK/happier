import * as React from 'react';
import { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

// Native primitives and Animated are the platform boundary; geometry, selection and accessibility remain real.
vi.mock('react-native', () => ({
  Platform: { OS: 'android', select: <T,>(options: Readonly<{ android?: T; native?: T; default?: T }>) => options.android ?? options.native ?? options.default },
  Pressable: 'Pressable', Text: 'Text', View: 'View',
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles },
  Animated: { Value: class { setValue() {} stopAnimation() {} }, View: 'AnimatedView' },
  Easing: {},
}));

import { SURFACE_CONTEXT_THEME_FIXTURE as theme } from '../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import { HappierUiPlatformProvider } from '../../environment/context.js';
import { StackedSeriesChart } from './StackedSeriesChart.js';

let renderer: ReactTestRenderer | undefined;
afterEach(() => { act(() => renderer?.unmount()); renderer = undefined; });

const points = Array.from({ length: 45_000 }, (_, x) => ({ id: `p${x}`, x, y: x === 0 ? 0.00004 : x === 1 ? null : x === 2 ? 0 : x }));
const input = [{ id: 'used', label: 'Used', points }];

it('does not mount per-point Views in a native inline history while retaining every exact accessible fact', () => {
  act(() => { renderer = create(<HappierUiPlatformProvider platform={{ platform: 'android', colorScheme: 'light' }}>
    <StackedSeriesChart theme={theme} label="Allowance" width={320} series={[{ ...input[0]!, points: points.slice(0, 2) }]}
      variant="line" size="inline" />
  </HappierUiPlatformProvider>); });
  act(() => renderer!.unmount());
  renderer = undefined;
  const before = process.memoryUsage();
  const started = performance.now();
  act(() => { renderer = create(<HappierUiPlatformProvider platform={{ platform: 'android', colorScheme: 'light' }}>
    <StackedSeriesChart theme={theme} label="Allowance" width={320} series={input} variant="line" size="inline" testID="native-inline" />
  </HappierUiPlatformProvider>); });
  const after = process.memoryUsage();
  console.info('native-inline-history-mount', JSON.stringify({ elapsedMs: performance.now() - started,
    heapUsedDelta: after.heapUsed - before.heapUsed, rssDelta: after.rss - before.rss, views: renderer!.root.findAllByType('View').length }));
  expect(renderer!.root.findAllByType('View').length).toBeLessThan(100);
  expect(renderer!.root.findAllByType('Pressable')).toHaveLength(0);
  const description = renderer!.root.findAllByType('View').find(node => node.props.testID === 'native-inline')!.props.accessibilityLabel;
  expect(description).toContain('Used 0.00004');
  expect(description).toContain('Used —');
  expect(description).toContain('2: Used 0;');
  expect(description).toContain('Used 44,999');
}, 180_000);

it('keeps an unmeasured native tile finite and selects exact samples through native accessibility actions', () => {
  act(() => { renderer = create(<HappierUiPlatformProvider platform={{ platform: 'android', colorScheme: 'light' }}>
    <StackedSeriesChart theme={theme} label="Allowance" series={input} variant="line" size="tile" testID="native-tile" />
  </HappierUiPlatformProvider>); });
  expect(renderer!.root.findAllByType('Pressable')).toHaveLength(1);
  const control = () => renderer!.root.findAllByType('Pressable')[0]!;
  expect(control().props.accessibilityLabel).toContain('Used 0.00004');
  expect(control().props.accessibilityActions).toEqual([{ name: 'increment' }, { name: 'decrement' }]);
  expect(control().props.accessibilityCollectionItem.rowIndex).toBe(0);
  expect(JSON.stringify(control().props.style)).toContain('"minHeight":48');
  act(() => control().props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } }));
  expect(control().props.accessibilityLabel).toContain('Used —');
  act(() => control().props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } }));
  expect(control().props.accessibilityLabel).toBe('2: Used 0');
  act(() => control().props.onAccessibilityAction({ nativeEvent: { actionName: 'decrement' } }));
  expect(control().props.accessibilityLabel).toContain('Used —');
  act(() => renderer!.root.findAllByType('View').find(node => node.props.testID === 'native-tile')!.props.onLayout({
    nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 64 } },
  }));
  expect(renderer!.root.findAllByType('Pressable')).toHaveLength(1);
  expect(control().props['aria-setsize']).toBe(45_000);
  expect(control().props.accessibilityCollectionItem.rowIndex).toBe(1);
}, 180_000);
