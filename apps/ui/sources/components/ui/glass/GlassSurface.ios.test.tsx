import * as React from 'react';
import Color from 'color';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen, flattenTestStyle, standardCleanup } from '@/dev/testkit';

// iOS's platform renderer and the native material SDKs are the system boundary; material policy stays real.
vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('expo-glass-effect', () => ({ isLiquidGlassAvailable: () => false }));
vi.mock('expo-blur', () => ({
  BlurView: (props: Record<string, unknown>) =>
    React.createElement('BlurView', props),
}));
vi.mock('react-native-reanimated', async () => {
  const { createReanimatedModuleMock } =
    await import('@/dev/testkit/mocks/reanimated');
  return createReanimatedModuleMock();
});
vi.mock('expo-linear-gradient', () => ({
  LinearGradient: (props: Record<string, unknown>) =>
    React.createElement('LinearGradient', props),
}));

describe('iOS material without blur', () => {
  it('keeps an authored translucent coat with Blur Off as a tint, while accessibility, an inactive window and Solid stay opaque', async () => {
    const { GlassSurface } = await import('./GlassSurface');
    const { GlassRuntimeEnvironmentProvider } =
      await import('./glassRuntimeEnvironment');
    const { GlassMaterialSettingsProvider } =
      await import('./useGlassMaterialSettings');
    const { glassPresetMaterials } = await import('./glassMaterial');
    const custom = {
      ...glassPresetMaterials('auto'),
      floating: { blur: 'off', opacity: 0.33 },
    } as const;
    for (const [materials, environment, alpha] of [
      [custom, {}, 0.33],
      [custom, { reduceTransparency: true }, 1],
      [custom, { windowActive: false }, 1],
      [glassPresetMaterials('solid'), {}, 1],
    ] as const) {
      const screen = await renderScreen(
        <GlassRuntimeEnvironmentProvider value={environment}>
          <GlassMaterialSettingsProvider
            value={{ glassSurfaceMaterials: materials }}
          >
            <GlassSurface testID="ios-material" solidColor="#204060">
              <></>
            </GlassSurface>
          </GlassMaterialSettingsProvider>
        </GlassRuntimeEnvironmentProvider>,
      );
      const fill = flattenTestStyle(
        screen.findByTestId('ios-material')?.props.style,
      ).backgroundColor;
      expect(Color(String(fill)).alpha()).toBeCloseTo(alpha, 2);
      expect(screen.findAllByType('BlurView')).toHaveLength(0);
      standardCleanup();
    }
  });
});
