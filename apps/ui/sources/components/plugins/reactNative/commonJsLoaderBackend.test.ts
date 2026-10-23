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
        expect(await load()).not.toBe(ready);
        expect(Reflect.get(globalThis, '__dg8FailedEvaluations')).toBe(3);
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
