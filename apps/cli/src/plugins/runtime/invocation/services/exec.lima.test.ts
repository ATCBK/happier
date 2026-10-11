import { describe, expect, it, vi } from 'vitest';
import type { PluginApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import { LIMA_PLUGIN } from '@happier-dev/plugins-machine-lima/manifest';

import { createProductionPluginInvocationServiceOwners } from './production';

describe('Lima declared native process environment', () => {
    it('checks an installed Lima through the admitted HOME and PATH without inheriting unrelated environment', async () => {
        const requests = LIMA_PLUGIN.manifest.hostAccess.required.map((request) => ({ request, required: true }));
        vi.stubEnv('HOME', '/fixture/lima-home');
        vi.stubEnv('PATH', '/fixture/native-tools');
        vi.stubEnv('UNRELATED_SECRET', 'not-admitted');
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write() {} },
            exec: {
                // Only the native executable is replaced. Real manifest admission,
                // ExecService, process supervision, parsing and the Action stay real.
                resolveExecutable: async () => ({ command: process.execPath, args: ['-e', `
                    if (process.env.HOME !== '/fixture/lima-home' || process.env.PATH !== '/fixture/native-tools'
                        || process.env.UNRELATED_SECRET) process.exit(2);
                    process.stdout.write(process.argv[1] === '--version'
                        ? 'limactl version 2.2.1'
                        : JSON.stringify({hostOS:'linux',hostArch:'x86_64',vmTypes:['qemu']}));
                `, '--'] }),
                resolvePath: async () => process.cwd(),
            },
        });
        const seed = {
            plugin: { id: LIMA_PLUGIN.manifest.id, version: '0.0.0' },
            contribution: { id: 'check', qualifiedId: `${LIMA_PLUGIN.manifest.id}/actions/check` },
            occurrenceId: 'lima-test', correlationId: 'lima-test', surface: 'cli' as const,
            signal: new AbortController().signal, isOccurrenceCurrent: () => true,
        };
        const binding = owners.resolveInvocationHostPolicy({
            pluginId: seed.plugin.id, occurrenceId: seed.occurrenceId, qualifiedId: seed.contribution.qualifiedId,
        }, { hostAccessRequests: requests, surface: seed.surface, signal: seed.signal }).serviceBinding;
        const services = owners.createServices(seed, binding);
        const handlers = new Map<string, ActionHandler>();
        const api = { actions: { register(id: string, handler: ActionHandler) {
            handlers.set(id, handler);
            return { dispose() {} };
        } } } as unknown as PluginApi;
        await LIMA_PLUGIN.activate(api);
        const context = {
            invokedAtMs: 123,
            signal: new AbortController().signal,
            services: { ...services, managedServices: { dependencies: { status: async (id: string) => ({
                state: 'ready', id, version: '2.2.1', sourceId: 'system',
                executable: { kind: 'managedDependency', id: { pluginId: LIMA_PLUGIN.manifest.id, localId: id } },
            }) } } },
        } as unknown as PluginInvocationContext;
        const check = handlers.get('check');
        if (!check) throw new Error('Lima check Action was not activated');
        try {
            expect(await check({}, context)).toMatchObject({ available: true });
        } finally {
            await owners.dispose();
            vi.unstubAllEnvs();
        }
    });
});
