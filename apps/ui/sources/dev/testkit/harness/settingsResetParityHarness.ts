import { vi } from 'vitest';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { createSettingsDeclarationAction } from '@/sync/ops/actions/settingsDeclarationAction';
import { settingsParse, applySettings } from '@/sync/domains/settings/settings';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { readSettingsPageGate } from '@/components/settings/catalog/pageCatalog';

// Only native/platform boundaries are substituted; declaration and mutation owners stay real.
vi.mock('expo-audio', () => ({ createAudioPlayer: () => ({ play: vi.fn(), remove: vi.fn(), addListener: () => ({ remove: vi.fn() }) }),
    AudioModule: { setAudioModeAsync: vi.fn(async () => {}) } }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('../mocks/reactNative');
    return createReactNativeWebMock({ Appearance: { getColorScheme: () => 'light' } });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('../mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('expo-updates', async () => {
    const { createExpoUpdatesMock } = await import('../mocks/expoUpdates');
    return createExpoUpdatesMock();
});
// This native font adapter's CJS loader bypasses Vite's React Native alias.
vi.mock('react-native-typography', async () => {
    const { createReactNativeTypographyMock } = await import('../mocks/reactNativeTypography');
    return createReactNativeTypographyMock();
});
// Skia's renderer/native handles do not exist in this Node host.
vi.mock('@shopify/react-native-skia', async () => {
    const { createReactNativeSkiaMock } = await import('../mocks/reactNativeSkia');
    return createReactNativeSkiaMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('../mocks/modal');
    return createModalModuleMock().module;
});

/** Latest-snapshot persistence boundary for the composed UI/CLI reset contract. */
export function createSettingsResetParityHost(params: Readonly<{
    initial: Readonly<Record<string, unknown>>;
    mutationSnapshot: Readonly<Record<string, unknown>>;
}>): Readonly<{
    settingsDeclarationAction: NonNullable<ActionExecutorDeps['settingsDeclarationAction']>;
    readSettings(): Readonly<Record<string, unknown>>;
}> {
    let settings = settingsParse(params.initial);
    const settingsDeclarationAction = createSettingsDeclarationAction({
        host: { os: 'web', desktop: false }, tauriDesktop: false,
        readPageGate: readSettingsPageGate, isFeatureEnabled: async () => true,
        readAccountSettings: async () => settings,
        writeAccountSettings: async delta => { settings = applySettings(settings, delta); },
        mutateAccountSettings: async mutate => { settings = settingsParse(mutate(params.mutationSnapshot)); },
        readLocalSettings: () => localSettingsDefaults,
        writeLocalSettings: () => { throw new Error('unexpected_device_write'); },
    });
    return { settingsDeclarationAction, readSettings: () => settings };
}
