/** @vitest-environment jsdom */
import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { flattenTestStyle } from '@/dev/testkit';
import Color from 'color';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    const { lightTheme } = await import('@/theme');
    return createUnistylesMock({ theme: {
        ...lightTheme,
        colors: {
            ...lightTheme.colors,
            surface: {
                ...lightTheme.colors.surface,
                base: 'var(--colors-surface-base)',
                elevated: 'var(--colors-surface-elevated)',
            },
            edge: {
                ...lightTheme.colors.edge,
                cardFill: 'var(--colors-edge-card-fill)',
                floatingFill: 'var(--colors-edge-floating-fill)',
            },
        },
    } });
});
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({});
});

import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { GlassRuntimeEnvironmentProvider } from '@/components/ui/glass/glassRuntimeEnvironment';
import { glassPresetMaterials } from '@/components/ui/glass/glassMaterial';
import { GlassMaterialSettingsProvider } from '@/components/ui/glass/useGlassMaterialSettings';
import { KeyHint } from '@/components/ui/keyboard/KeyHint';
import { AnchoredTooltipBubble } from '@/components/ui/overlays/AnchoredTooltip';
import { TerminalArrowPad } from '@/components/terminal/embedded/keys/TerminalArrowPad';

beforeEach(async () => {
    const { lightTheme } = await import('@/theme');
    document.documentElement.style.setProperty('--colors-surface-base', lightTheme.colors.surface.base);
    document.documentElement.style.setProperty('--colors-surface-elevated', lightTheme.colors.surface.elevated);
    document.documentElement.style.setProperty('--colors-edge-card-fill', lightTheme.colors.edge.cardFill);
    document.documentElement.style.setProperty('--colors-edge-floating-fill', lightTheme.colors.edge.floatingFill);
});

afterEach(() => {
    standardCleanup();
    document.documentElement.removeAttribute('style');
});

it('renders the tooltip bubble and card material when Unistyles supplies CSS-variable colours', async () => {
    const screen = await renderScreen(
        <GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('auto') }}>
            <GlassRuntimeEnvironmentProvider value={{ atmosphereBehind: 'band' }}>
                <AnchoredTooltipBubble label="Tooltip" testID="css-variable-tooltip" />
                <GlassSurface surfaceGroup="card" finishRole={null} solidColor="var(--colors-edge-card-fill)" testID="css-variable-card"><React.Fragment /></GlassSurface>
            </GlassRuntimeEnvironmentProvider>
        </GlassMaterialSettingsProvider>,
    );

    expect(screen.findHostByTestId('css-variable-tooltip')).not.toBeNull();
    expect(screen.findHostByTestId('css-variable-card')).not.toBeNull();
});

it('derives material paint inside a CSS-variable tooltip without passing the token to Color', async () => {
    const screen = await renderScreen(
        <GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('auto') }}>
            <GlassRuntimeEnvironmentProvider value={{ atmosphereBehind: 'band' }}>
                <AnchoredTooltipBubble label="Keyboard shortcut" testID="css-variable-tooltip" content={<KeyHint label="K" tone="onFill" />} />
            </GlassRuntimeEnvironmentProvider>
        </GlassMaterialSettingsProvider>,
    );

    expect(screen.findHostByTestId('css-variable-tooltip')).not.toBeNull();
});

it('renders a terminal arrow pad whose theme surface paint is a CSS variable', async () => {
    const screen = await renderScreen(<TerminalArrowPad area={{ width: 390, height: 600 }} onArrow={() => {}} testIdPrefix="variable" />);
    expect(screen.findHostByTestId('variable-arrow-pad')).not.toBeNull();
    const { lightTheme } = await import('@/theme');
    expect(flattenTestStyle(screen.findHostByTestId('variable-arrow-pad-up')?.props.style).backgroundColor)
        .toBe(Color(lightTheme.colors.surface.base).alpha(0.56).rgb().string());
});
