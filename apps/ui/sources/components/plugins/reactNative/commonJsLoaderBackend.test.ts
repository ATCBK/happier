import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { createPluginUiCommonJsLoaderBackend } from './commonJsLoaderBackend';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';

const bytes = new TextEncoder().encode('exports.renderSurface = () => "universal";');

describe('createPluginUiCommonJsLoaderBackend', () => {
    it('retries failed module initialization without retaining a partial namespace', async () => {
        vi.stubGlobal('__dg8FailedEvaluations', 0);
        onTestFinished(() => { vi.unstubAllGlobals(); });
        const identity: PluginReactNativeBundleCacheIdentity = { pluginId: 'external.dg8-retry', contributionId: 'runtime', artifactId: 'runtime',
            artifactDigest: 'sha256:dg8-retry', platform: 'web' };
        const bytes = new TextEncoder().encode(`
            if (++globalThis.__dg8FailedEvaluations === 1) throw new Error('initialization failed');
            exports.activate = () => 'ready';
        `);
        const load = () => createPluginUiCommonJsLoaderBackend().loadInstalledBundle!({
            identity, bytes, moduleReference: { exportName: 'activate' },
        });
        await expect(load()).rejects.toMatchObject({ code: 'module_instantiation_failed' });
        const ready = await load();
        expect(ready()).toBe('ready');
        expect(await load()).toBe(ready);
        expect(Reflect.get(globalThis, '__dg8FailedEvaluations')).toBe(2);
    });

    it('shares an evaluated namespace across exports and projected locators, but evaluates changed artifact identities', async () => {
        vi.stubGlobal('__dg8LoaderEvaluations', 0);
        onTestFinished(() => { vi.unstubAllGlobals(); });
        const source = new TextEncoder().encode(`
            globalThis.__dg8LoaderEvaluations++;
            const token = {};
            exports.activate = () => token;
            exports.renderSurface = () => token;
        `);
        const identity: PluginReactNativeBundleCacheIdentity = { pluginId: 'external.dg8', contributionId: 'first', artifactId: 'runtime',
            artifactDigest: 'sha256:dg8-original', platform: 'web' };
        const load = (inputIdentity = identity, exportName = 'activate') => createPluginUiCommonJsLoaderBackend()
            .loadInstalledBundle!({ identity: inputIdentity, bytes: new Uint8Array(source), moduleReference: { exportName } });
        const first = await load();
        const otherExport = await load({ ...identity, contributionId: 'second' }, 'renderSurface');
        expect(first()).toBe(otherExport());
        expect(Reflect.get(globalThis, '__dg8LoaderEvaluations')).toBe(1);
        await expect(load(identity, 'missing')).rejects.toMatchObject({ code: 'invalid_executable_export' });
        expect(await load()).toBe(first);
        const changed = await load({ ...identity, artifactDigest: 'sha256:dg8-replacement' });
        expect(changed()).not.toBe(first());
        expect(Reflect.get(globalThis, '__dg8LoaderEvaluations')).toBe(2);
        await load({ ...identity, pluginId: 'other.dg8' });
        await load({ ...identity, artifactId: 'other-runtime' });
        expect(Reflect.get(globalThis, '__dg8LoaderEvaluations')).toBe(4);
    });

    it.each(['web', 'ios', 'android'] as const)(
        'evaluates the same universal CommonJS artifact on %s',
        async (platform) => {
            const backend = createPluginUiCommonJsLoaderBackend();
            const exported = await backend.loadInstalledBundle?.({
                identity: {
                    pluginId: 'example.universal',
                    contributionId: 'main-renderer',
                    artifactId: 'main-renderer',
                    artifactDigest: 'sha256:universal',
                    platform,
                },
                bytes,
                moduleReference: { exportName: 'renderSurface' },
            });

            expect(exported).toBeTypeOf('function');
            expect(exported?.()).toBe('universal');
        },
    );
});
