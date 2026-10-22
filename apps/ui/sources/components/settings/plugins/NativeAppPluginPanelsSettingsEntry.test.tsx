import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
    type PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';

const routerPushSpy = vi.hoisted(() => vi.fn());
const appShellProjectionState = vi.hoisted(() => ({
    value: null as PluginUiProjectionModel | null,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'ios' },
        View: 'View',
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: routerPushSpy } }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

import { EMPTY_PLUGIN_SKILL_SOURCE_IDENTITY } from '@/sync/domains/skills/pluginSkillSourceIdentity';

vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/components/appShell/plugins/AppShellPluginUiProjection')>(),
    useAppShellPluginUiDeclarationSources: () => ({
        projection: appShellProjectionState.value, skillSourceIdentity: EMPTY_PLUGIN_SKILL_SOURCE_IDENTITY, accountLifetime: null, ready: true,
    }),
    useAppShellPluginUiProjection: () => ({
        pluginUiProjection: appShellProjectionState.value,
        machineId: null,
        serverId: null,
        platform: 'ios',
    }),
    useProjectedPluginLocalizedTextResolver: () => (
        _pluginId: string,
        value: string | Readonly<{ key: string; fallback: string }>,
    ) => typeof value === 'string' ? value : value.fallback,
}));

const appSidebarBinding = normalizePluginUiDestinationBindingV1({
    pluginId: 'happier.dev.inspector',
    destinationId: 'app-panel',
    rendererId: 'inspector-panel-renderer',
    container: 'rightSidebarTab',
    target: { kind: 'app' },
});
if (!appSidebarBinding) throw new Error('App panel fixture needs a normalized V2 binding');

const appSidebarPlacement = {
    id: 'surfacePlacement:happier.dev.inspector:app-panel',
    pluginId: 'happier.dev.inspector',
    occurrenceId: 'happier.dev.inspector:app-panel:occurrence-1',
    contributionKind: 'surfacePlacement',
    descriptorId: 'app-panel',
    binding: appSidebarBinding,
    target: { kind: 'app' },
    renderer: { kind: 'reactNative', contributionId: 'inspector-panel-renderer' },
    display: { titleKey: 'app-panel', developerFallback: 'Inspector' },
    availability: { state: 'available', reason: 'available', diagnostics: [] },
    headerActions: [],
    order: 10,
    rightSidebar: {
        scope: 'app',
        section: 'plugin',
        disabledPolicy: 'hide',
        collisionPolicy: 'reject',
        lifecycle: { retention: 'unmountOnDisable', unmountOnGenerationChange: true },
    },
} as const satisfies PluginUiSurfacePlacementProjection;

function projectionWith(...placements: readonly PluginUiSurfacePlacementProjection[]): PluginUiProjectionModel {
    return {
        ...EMPTY_PLUGIN_UI_PROJECTION,
        surfacePlacementsById: Object.freeze(Object.fromEntries(placements.map((entry) => [entry.id, entry]))),
    };
}

afterEach(() => {
    standardCleanup();
    routerPushSpy.mockClear();
    appShellProjectionState.value = null;
});

// Load real screen owners after boundary setup, outside behavior deadlines.
const { NativeAppPluginPanelsSettingsEntry } = await import('./NativeAppPluginPanelsSettingsEntry');

describe('NativeAppPluginPanelsSettingsEntry', () => {
    it.each(['ios', 'android'] as const)(
        'exposes renderable app-scoped plugin panels through native settings navigation on %s',
        async (platform) => {
            appShellProjectionState.value = projectionWith(appSidebarPlacement);
            const screen = await renderScreen(
                <NativeAppPluginPanelsSettingsEntry
                    platform={platform}
                />,
            );

            const entry = screen.findByTestId('settings.plugins.appPanels');
            expect(entry?.props.accessibilityLabel).toBe('settingsPlugins.appPanelsTitle');

            entry?.props.onPress();

            expect(routerPushSpy).toHaveBeenCalledWith('/plugins/panels');
        },
    );

    it('does not advertise the native route when no app panel is renderable', async () => {
        appShellProjectionState.value = projectionWith({
            ...appSidebarPlacement,
            availability: { state: 'fallback', reason: 'feature_disabled', diagnostics: [] },
        });
        const screen = await renderScreen(
            <NativeAppPluginPanelsSettingsEntry
                platform="ios"
            />,
        );

        expect(screen.findByTestId('settings.plugins.appPanels')).toBeNull();
    });

    it('leaves the established web/desktop path unchanged', async () => {
        appShellProjectionState.value = projectionWith(appSidebarPlacement);
        const screen = await renderScreen(
            <NativeAppPluginPanelsSettingsEntry
                platform="web"
            />,
        );

        expect(screen.findByTestId('settings.plugins.appPanels')).toBeNull();
    });
});
