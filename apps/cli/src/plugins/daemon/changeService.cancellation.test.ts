import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';

import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { createDaemonPluginRegistryRuntimeLifecycle } from '@/plugins/runtime/reload/registryRuntimeLifecycle';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { createDaemonPathPluginChangePreparer } from './pathChangePreparer';
import { createDaemonPluginChangeService } from './changeService';

const filesystemObservation = vi.hoisted((): { afterRealpath?: (path: unknown) => void } => ({}));
// The filesystem is the external boundary; all source admission, candidate
// preparation, review retention, registry mutation and cleanup remain real.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, realpath: async (...args: Parameters<typeof actual.realpath>) => {
        const result = await actual.realpath(...args);
        filesystemObservation.afterRealpath?.(args[0]);
        return result;
    } };
});

async function createFixture(onRegistryApplied?: () => void) {
    const root = await fs.mkdtemp(join(tmpdir(), 'plugin-change-cancellation-'));
    const happyHomeDir = join(root, 'home');
    const pluginRoot = join(root, 'source');
    await fs.mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await fs.writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(createPluginManifestV2Fixture({
        id: 'acme.cancellation', entrypoints: undefined,
    })));
    const reloadController = createPluginReloadController({ happyHomeDir });
    const signal = new AbortController();
    const prepare = createDaemonPathPluginChangePreparer({ happyHomeDir,
        runtimeLifecycle: createDaemonPluginRegistryRuntimeLifecycle({ happyHomeDir, reloadController }),
        onRegistryApplied,
    });
    const service = createDaemonPluginChangeService({ prepare });
    return { root, happyHomeDir, pluginRoot, signal, service,
        async close() {
            await service.shutdown();
            await reloadController.shutdown();
            await fs.rm(root, { recursive: true, force: true });
        },
    };
}

describe('plugin change cancellation through real path preparation', () => {
    it.each(['before_work', 'during_preparation'] as const)('retires an uncommitted candidate when cancelled %s', async phase => {
        const fixture = await createFixture();
        if (phase === 'during_preparation') filesystemObservation.afterRealpath = path => {
            if (String(path) === fixture.pluginRoot) fixture.signal.abort();
        };
        if (phase === 'before_work') fixture.signal.abort();
        try {
            const result = await fixture.service.requestPluginChange({ kind: 'installPath', locator: fixture.pluginRoot },
                { signal: fixture.signal.signal });
            expect(fixture.signal.signal.aborted).toBe(true);
            expect(result).toEqual({ kind: 'cancelled' });
            expect((await fixture.service.listPendingPluginChanges()).changes).toEqual([]);
            expect((await createPluginRegistryStateStore({ happyHomeDir: fixture.happyHomeDir }).read()).plugins['acme.cancellation'])
                .toBeUndefined();
            const paths = resolvePluginStorePaths({ happyHomeDir: fixture.happyHomeDir });
            expect(await fs.readdir(paths.generationsDir).catch((error: unknown) => {
                if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
                throw error;
            })).toEqual([]);
        } finally {
            filesystemObservation.afterRealpath = undefined;
            await fixture.close();
        }
    });

    it('returns the actual committed outcome when cancellation arrives after mutation', async () => {
        const signal = new AbortController();
        let observeMutation = false;
        const fixture = await createFixture(() => { if (observeMutation) signal.abort(); });
        try {
            const review = await fixture.service.requestPluginChange({ kind: 'installPath', locator: fixture.pluginRoot });
            if (review.kind !== 'reviewRequired') throw new Error('Expected the real source installation review');
            await expect(fixture.service.decidePluginChange({ pendingChangeId: review.pendingChangeId, decision: 'installAndTrust' }))
                .resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.cancellation' });
            observeMutation = true;
            await expect(fixture.service.requestPluginChange({ kind: 'setUpdatePolicy', pluginId: 'acme.cancellation', policy: 'pinned' },
                { signal: signal.signal })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.cancellation' });
            expect(signal.signal.aborted).toBe(true);
            expect((await createPluginRegistryStateStore({ happyHomeDir: fixture.happyHomeDir }).read()).plugins['acme.cancellation'])
                .toMatchObject({ install: { updatePolicy: 'pinned' } });
        } finally {
            await fixture.close();
        }
    });
});
