import { describe, expect, it } from 'vitest';
import type { PluginApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import { LIMA_PLUGIN } from '@happier-dev/plugins-machine-lima/manifest';

import { createStablePluginExecService } from './exec';
import { addExecServiceBinding, createLoggerAvailablePluginInvocationServiceBinding } from './factory';

describe('Lima declared native process environment', () => {
    it('checks an installed Lima through the admitted HOME and PATH without inheriting unrelated environment', async () => {
        const requests = LIMA_PLUGIN.manifest.hostAccess.required.map((request) => ({ request, required: true }));
        const binding = addExecServiceBinding(
            createLoggerAvailablePluginInvocationServiceBinding('lima-test', LIMA_PLUGIN.manifest.id),
            requests,
            true,
        );
        const exec = createStablePluginExecService({
            allowedExecutables: binding.processExecutables ?? [],
            allowedEnvKeys: binding.processEnvKeys,
            environment: { HOME: '/fixture/lima-home', PATH: '/fixture/native-tools', UNRELATED_SECRET: 'not-admitted' },
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
            // Only the native executable is replaced. Real manifest admission,
            // ExecService, process supervision, parsing and the Action stay real.
            resolveExecutable: async () => ({ command: process.execPath, args: ['-e', `
                if (!process.env.HOME || !process.env.PATH || process.env.UNRELATED_SECRET) process.exit(2);
                process.stdout.write(process.argv[1] === '--version'
                    ? 'limactl version 2.2.1'
                    : JSON.stringify({hostOS:'linux',hostArch:'x86_64',vmTypes:['qemu']}));
            `, '--'] }),
            resolvePath: async () => process.cwd(),
        });
        const handlers = new Map<string, ActionHandler>();
        const api = { actions: { register(id: string, handler: ActionHandler) {
            handlers.set(id, handler);
            return { dispose() {} };
        } } } as unknown as PluginApi;
        await LIMA_PLUGIN.activate(api);
        const context = {
            invokedAtMs: 123,
            signal: new AbortController().signal,
            services: { exec, managedServices: { dependencies: { status: async (id: string) => ({
                state: 'ready', id, version: '2.2.1', sourceId: 'system',
                executable: { kind: 'managedDependency', id: { pluginId: LIMA_PLUGIN.manifest.id, localId: id } },
            }) } } },
        } as unknown as PluginInvocationContext;
        const check = handlers.get('check');
        if (!check) throw new Error('Lima check Action was not activated');
        expect(await check({}, context)).toMatchObject({ available: true });
    });
});
