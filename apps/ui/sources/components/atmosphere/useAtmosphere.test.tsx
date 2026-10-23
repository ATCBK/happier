import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { DEFAULT_HOME_ATMOSPHERE } from '@happier-dev/protocol/account/settings/accountSettings';
import { GlassRuntimeEnvironmentProvider } from '@/components/ui/glass/glassRuntimeEnvironment';
import { pictureStore } from './pictureStore.web';
import { useAtmosphere } from './useAtmosphere';
import { AppShellPluginUiProjectionValueProvider, type AppShellPluginUiProjectionValue } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { useAtmospherePictureCatalog } from './useAtmospherePictureCatalog';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('./pictureStore', async () => import('./pictureStore.web'));

const initial = storage.getState();
afterEach(() => { storage.setState(initial, true); });

describe('Atmosphere input locality', () => {
    it('keeps newer same-id bytes when an older IndexedDB read completes later', async () => {
        const localId = 'same-id-read-order';
        await pictureStore.put({ localId, kind: 'user', data: new Blob(['old']) });
        storage.setState(state => ({ settings: { ...state.settings, homeAtmosphere: {
            ...DEFAULT_HOME_ATMOSPHERE, source: 'picture',
            picture: { ...DEFAULT_HOME_ATMOSPHERE.picture, ref: { kind: 'user', localId } },
        } } }));
        const dispatch = IDBTransaction.prototype.dispatchEvent;
        let release: (() => void) | undefined;
        // Delay one completed read at the database boundary, preserving its earlier snapshot.
        const spy = vi.spyOn(IDBTransaction.prototype, 'dispatchEvent').mockImplementation(function (this: IDBTransaction, event: Event) {
            if (!release && event.type === 'complete' && this.mode === 'readonly' && this.objectStoreNames.contains('pictures')) {
                release = () => { dispatch.call(this, event); };
                return true;
            }
            return dispatch.call(this, event);
        });
        let shown: ReturnType<typeof useAtmosphere> | undefined;
        function Probe() { shown = useAtmosphere('home'); return null; }
        const screen = await renderScreen(<Probe />);
        try {
            await act(async () => {
                await pictureStore.put({ localId, kind: 'user', data: new Blob(['new']) });
                await pictureStore.get(localId);
            });
            const newest = shown?.pictureRecord;
            expect(newest?.data).toBeInstanceOf(Blob);
            await act(async () => { release?.(); });
            expect(shown?.pictureRecord).toBe(newest);
            const data = shown?.pictureRecord?.data;
            expect(data instanceof Blob ? await data.text() : data).toBe('new');
        } finally { spy.mockRestore(); await screen.unmount(); }
    });
    it('does not render catalog readers for unrelated plugin executable publications', async () => {
        let renders = 0;
        function Probe() { useAtmospherePictureCatalog(); renders += 1; return null; }
        const value: AppShellPluginUiProjectionValue = {
            pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null,
            phase: 'current', interactionEnabled: true, machineId: null, serverId: null,
            platform: 'web', accountLifetime: null, connectedAccountProjectionRevision: 1,
            reloadConnectedAccountProjection: () => {}, clientExecutableActivation: { status: 'ready' },
            reloadClientExecutables: () => {},
        };
        const child = <Probe />;
        const screen = await renderScreen(<AppShellPluginUiProjectionValueProvider value={value}>{child}</AppShellPluginUiProjectionValueProvider>);
        renders = 0;
        for (let index = 0; index < 5; index += 1) {
            await screen.update(<AppShellPluginUiProjectionValueProvider value={{ ...value, connectedAccountProjectionRevision: index + 2 }}>{child}</AppShellPluginUiProjectionValueProvider>);
        }
        expect(renders).toBe(0);
    });
    it('keeps one resolved identity across parent renders and unrelated glass environment changes', async () => {
        storage.setState(state => ({ settings: { ...state.settings, homeAtmosphere: DEFAULT_HOME_ATMOSPHERE } }));
        let publications = 0;
        function Probe() {
            const atmosphere = useAtmosphere('home');
            React.useEffect(() => { publications += 1; }, [atmosphere]);
            return null;
        }
        const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ windowActive: true }}><Probe /></GlassRuntimeEnvironmentProvider>);
        publications = 0;
        for (let index = 0; index < 5; index += 1) {
            await screen.update(<GlassRuntimeEnvironmentProvider value={{ windowActive: index % 2 === 0 }}><Probe /></GlassRuntimeEnvironmentProvider>);
        }
        expect(publications).toBe(0);
        await screen.update(<GlassRuntimeEnvironmentProvider value={{ reduceTransparency: true }}><Probe /></GlassRuntimeEnvironmentProvider>);
        expect(publications).toBe(1);
    });

    it('does not render Planet for unrelated picture writes', async () => {
        storage.setState(state => ({ settings: { ...state.settings, homeAtmosphere: DEFAULT_HOME_ATMOSPHERE } }));
        let renders = 0;
        function Probe() { useAtmosphere('home'); renders += 1; return null; }
        await renderScreen(<Probe />);
        renders = 0;
        await act(async () => {
            await pictureStore.put({ localId: 'unrelated-to-planet', kind: 'user', data: new Blob(['pixels']) });
        });
        expect(renders).toBe(0);
    });
});
