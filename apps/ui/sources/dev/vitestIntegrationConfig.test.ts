import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

type ResolveIdResult = string | null | undefined | false | { id?: string };

type PluginWithResolver = {
    name?: string;
    resolveId?: (id: string, importer?: string) => ResolveIdResult | Promise<ResolveIdResult>;
};

function getPlugins(value: unknown): PluginWithResolver[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.flatMap((plugin) => {
        if (Array.isArray(plugin)) {
            return getPlugins(plugin);
        }

        if (plugin && typeof plugin === 'object') {
            return [plugin as PluginWithResolver];
        }

        return [];
    });
}

describe('vitest integration config', () => {
    it('resolves app-local aliases from a composed integration importer', async () => {
        const { createVitest } = await import('vitest/node');
        const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
        const runtime = await createVitest('test', {
            root: packageRoot,
            config: fileURLToPath(new URL('../../vitest.integration.config.ts', import.meta.url)),
            watch: false,
            include: [],
        });
        try {
            const importer = fileURLToPath(new URL('../sync/ops/actions/sessionSpawnNewAction.composed.real.integration.test.ts', import.meta.url));
            const resolved = await runtime.vite.pluginContainer.resolveId('@/sync/ops/actions/defaultActionExecutor', importer);
            expect(resolved?.id).toBe(fileURLToPath(new URL('../sync/ops/actions/defaultActionExecutor.ts', import.meta.url)));
        } finally {
            await runtime.close();
        }
    });

    it('resolves workspace package imports through the inherited source resolver', async () => {
        const module = await import('../../vitest.integration.config');
        const plugins = getPlugins(module.default.plugins);
        const workspaceResolver = plugins.find((plugin) => (
            plugin.name === 'happier-vitest-expo-node-module-stubs'
        ));

        expect(workspaceResolver?.resolveId).toBeTypeOf('function');

        const result = await workspaceResolver?.resolveId?.('@happier-dev/connection-supervisor');
        const resolved = typeof result === 'string'
            ? result
            : result && typeof result === 'object'
                ? result.id
                : undefined;

        expect(resolved).toContain('/packages/connection-supervisor/src/index.ts');
    });
});
