import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
// Desktop IPC is the native window boundary; runtime, adapter and Account store stay real.
const host = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(async () => () => {}) }));
vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => true,
    invokeDesktopHost: host.invoke,
    listenDesktopHostEvent: host.listen,
}));

afterEach(() => { standardCleanup(); vi.clearAllMocks(); });

describe('desktop window material projection', () => {
    it('propagates the one atmosphere setter through runtime paint without changing native window material', async () => {
        const { GlassMaterialRuntime } = await import('./GlassMaterialRuntime');
        const { useGlassRuntimeEnvironment, useSetGlassAtmosphereBehind } = await import('./glassRuntimeEnvironment');
        const { resolveGlassPresentationVariables } = await import('./glassDocumentPresentation');
        const { useGlassMaterialSettings } = await import('./useGlassMaterialSettings');
        host.invoke.mockResolvedValue({ supported: true, materialLive: true, reduceTransparency: false, highContrast: false, windowActive: true });
        function Probe() {
            const environment = useGlassRuntimeEnvironment();
            const setAtmosphere = useSetGlassAtmosphereBehind();
            const settings = useGlassMaterialSettings();
            return React.createElement('Probe', { testID: 'atmosphere-probe', environment, setAtmosphere,
                variables: resolveGlassPresentationVariables(settings, environment) });
        }
        const screen = await renderScreen(<GlassMaterialRuntime><Probe /></GlassMaterialRuntime>);
        const probe = () => screen.findHostByTestId('atmosphere-probe')!;
        expect(probe().props.environment.atmosphereBehind).toBe('none');
        host.invoke.mockClear();
        for (const atmosphereBehind of ['band', 'wallpaper', 'none'] as const) {
            await act(async () => probe().props.setAtmosphere(atmosphereBehind));
            expect(probe().props.environment.atmosphereBehind).toBe(atmosphereBehind);
            if (atmosphereBehind !== 'none') expect(probe().props.variables['--happier-glass-content-plane-opacity']).toBe('0%');
            expect(host.invoke.mock.calls.filter(([name]) => name === 'desktop_apply_glass_material')).toEqual([]);
        }
    });
    it('uses chrome for the single window material and preserves floating changes in their own group', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const { GlassMaterialRuntime } = await import('./GlassMaterialRuntime');
        const { glassPresetMaterials } = await import('./glassMaterial');
        const before = storage.getState();
        host.invoke.mockResolvedValue({ supported: true, materialLive: true, reduceTransparency: false, highContrast: false, windowActive: true });
        const materials = { ...glassPresetMaterials('everywhere'), chrome: { blur: 'off' as const, opacity: 0 }, sidebar: { blur: 'light' as const, opacity: 0.2 }, content: { blur: 'regular' as const, opacity: 0.4 }, floating: { blur: 'strong' as const, opacity: 0.6 } };
        try {
            act(() => storage.setState({ settings: { ...before.settings, glassBlurEnabled: true, glassSurfaceMaterials: materials } }));
            await renderScreen(<GlassMaterialRuntime><React.Fragment /></GlassMaterialRuntime>);
            expect(host.invoke).toHaveBeenCalledWith('desktop_apply_glass_material', { enabled: true, blur: 'off' });
            host.invoke.mockClear();
            act(() => storage.setState({ settings: { ...storage.getState().settings, glassSurfaceMaterials: { ...materials, floating: { blur: 'light', opacity: 0 } } } }));
            await act(async () => {});
            expect(host.invoke.mock.calls.filter(([name]) => name === 'desktop_apply_glass_material').every(([, request]) => request.blur === 'off')).toBe(true);
            act(() => storage.setState({ settings: { ...storage.getState().settings, glassSurfaceMaterials: { ...materials, chrome: { blur: 'light', opacity: 0 } } } }));
            await act(async () => {});
            expect(host.invoke).toHaveBeenLastCalledWith('desktop_apply_glass_material', { enabled: true, blur: 'light' });
        } finally { standardCleanup(); act(() => storage.setState(before, true)); }
    });
});
