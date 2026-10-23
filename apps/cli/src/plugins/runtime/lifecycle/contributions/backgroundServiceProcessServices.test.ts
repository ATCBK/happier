import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createPluginInvocationServiceBinding } from '../../invocation/services/unavailable';
import { createBackgroundServiceProcessServices } from './backgroundServiceProcessServices';
import { createProductionPluginInvocationServiceOwners } from '../../invocation/services/production';
import { createStablePluginHttpHost } from '../../fetch/service';
import type { PluginInvocationLogRecord } from '../../invocation/services/logger';

describe('background process invocation services', () => {
    it('applies the daemon invocation redactor to child-local logger records', async () => {
        const records: PluginInvocationLogRecord[] = [];
        const controller = new AbortController();
        const parent = createProductionPluginInvocationServiceOwners({ loggerSink: { write: (record) => records.push(record) } });
        const seed = { plugin: { id: 'fixture', version: '1.0.0' }, contribution: { id: 'worker', qualifiedId: 'fixture/backgroundServices/worker' },
            occurrenceId: 'occurrence', correlationId: 'redaction', surface: 'background' as const, signal: controller.signal, isOccurrenceCurrent: () => !controller.signal.aborted };
        const binding = createPluginInvocationServiceBinding('occurrence', 'binding');
        parent.beginDiagnosticScope({ pluginId: 'fixture', occurrenceId: 'occurrence', correlationId: 'redaction' }, controller.signal, {}, []);
        parent.registerRawForRedaction(seed, 'opaque-credential-value');
        const longCredential = `opaque-native-${'abcXYZ'.repeat(1000)}`;
        parent.registerRawForRedaction(seed, longCredential);
        try {
            const prepared = await parent.prepareBackgroundServiceProcessLocalPolicy(seed, { ...binding, availability: { ...binding.availability, logger: 'available' } });
            const child = createBackgroundServiceProcessServices({ metadata: { plugin: seed.plugin, contribution: seed.contribution }, signal: controller.signal, clientServices: prepared.services, localPolicy: prepared.localPolicy });
            try {
                child.services.logger.info('result opaque-credential-value', { content: 'opaque-credential-value' });
                expect(records).toHaveLength(1);
                expect(JSON.stringify(records)).not.toContain('opaque-credential-value');
                expect(records[0]!.context.correlationId).toBe('redaction');
                child.services.logger.info(`result ${longCredential}`, { content: longCredential });
                expect(records).toHaveLength(2);
                expect(JSON.stringify(records)).not.toContain(longCredential.slice(0, 100));
            } finally { await child.dispose(); }
        } finally { controller.abort(); await parent.dispose(); }
    });

    it('uses the native reader operation roots and policy through the same services owner', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-process-native-services-'));
        await writeFile(join(directory, 'native-transcript'), 'native reader');
        const controller = new AbortController();
        const parent = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} }, filesystemRoots: { pluginData: '/not-the-native-root', workspace: '/not-the-native-root', projects: new Map() } });
        try {
            const prepared = await parent.prepareBackgroundServiceProcessOperationServices({
                plugin: { id: 'fixture', version: '1.0.0' }, contribution: { id: 'native-reader', qualifiedId: 'fixture/agents/native-reader' },
                occurrenceId: 'occurrence', correlationId: 'reader', surface: 'background', signal: controller.signal, isOccurrenceCurrent: () => !controller.signal.aborted,
            }, {
                filesystemRoots: { pluginData: directory, workspace: directory, projects: new Map() },
                hostAccessRequests: [{ required: true, request: { id: 'native-files', capability: 'filesystem', reason: 'Read native transcripts', scope: { locations: [{ root: 'workspace' }], access: ['read'] } } }],
            });
            const child = createBackgroundServiceProcessServices({ metadata: { plugin: { id: 'fixture', version: '1.0.0' }, contribution: { id: 'native-reader', qualifiedId: 'fixture/agents/native-reader' } },
                signal: controller.signal, localPolicy: prepared.localPolicy, clientServices: prepared.services });
            try {
                expect(Buffer.from(await child.services.fs.readFile({ root: 'workspace', relativePath: 'native-transcript' })).toString()).toBe('native reader');
            } finally { await child.dispose(); }
        } finally { controller.abort(); await parent.dispose(); await rm(directory, { force: true, recursive: true }); }
    });

    it('resolves system tools through the admitted owner and executes with child-local custody', async () => {
        const controller = new AbortController();
        const executable = { kind: 'systemTool' as const, id: 'fixture-tool' };
        const parent = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} }, exec: {
            resolveExecutable: async () => { throw new Error('System tool must use its selected grant'); },
            resolvePath: async () => { throw new Error('No cwd requested'); },
            systemToolsForPlugin: () => ({ resolve: async () => ({
                grantId: 'fixture', toolId: 'fixture-tool', displayName: 'Fixture', source: 'managed' as const,
                executablePath: process.execPath, launch: { kind: 'binary' as const, executablePath: process.execPath },
            }) }),
        } });
        const binding = createPluginInvocationServiceBinding('occurrence', 'binding');
        try {
            const prepared = await parent.prepareBackgroundServiceProcessLocalPolicy({
                plugin: { id: 'fixture', version: '1.0.0' }, contribution: { id: 'worker', qualifiedId: 'fixture/backgroundServices/worker' },
                occurrenceId: 'occurrence', correlationId: 'invocation', surface: 'background', signal: controller.signal, isOccurrenceCurrent: () => !controller.signal.aborted,
            }, { ...binding, availability: { ...binding.availability, logger: 'available', exec: 'available' }, processExecutables: [executable] });
            const child = createBackgroundServiceProcessServices({
                metadata: { plugin: { id: 'fixture', version: '1.0.0' }, contribution: { id: 'worker', qualifiedId: 'fixture/backgroundServices/worker' } },
                signal: controller.signal, localPolicy: prepared.localPolicy, clientServices: prepared.services,
            });
            try {
                const resolved = await child.services.exec.systemTools.resolve({ toolId: 'fixture-tool', purpose: 'Read fixture process identity' });
                const result = await child.services.exec.run({ executable: resolved.executable, args: ['-e', 'process.stdout.write("child-local")'] });
                expect(result.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
                expect(Buffer.from(result.stdout).toString()).toBe('child-local');
            } finally { await child.dispose(); }
        } finally { controller.abort(); await parent.dispose(); }
    });

    it('prepares admitted local policy through the existing production owner and preserves daemon HTTP policy', async () => {
        const controller = new AbortController();
        let revalidated = false;
        const host = createProductionPluginInvocationServiceOwners({
            loggerSink: { write() {} },
            filesystemRoots: { pluginData: '/tmp/plugin', workspace: '/tmp/workspace', projects: new Map() },
            http: createStablePluginHttpHost({
                adapter: { request: async () => { throw new Error('daemon performed HTTP I/O'); }, openWebSocket: async () => { throw new Error('not requested'); } },
                resolveNetworkAddresses: async () => ['93.184.216.34'],
                revalidateFinalPolicy: async () => { revalidated = true; },
            }),
        });
        const binding = createPluginInvocationServiceBinding('occurrence', 'binding');
        try {
            const prepared = await host.prepareBackgroundServiceProcessLocalPolicy({
                plugin: { id: 'fixture', version: '1.0.0' }, contribution: { id: 'worker', qualifiedId: 'fixture/backgroundServices/worker' },
                occurrenceId: 'occurrence', correlationId: 'invocation', surface: 'background', signal: controller.signal, isOccurrenceCurrent: () => !controller.signal.aborted,
            }, { ...binding, availability: { ...binding.availability, logger: 'available', fs: 'available', http: 'available' }, filesystemScopes: [], networkOrigins: ['https://example.test'] });
            expect(prepared.localPolicy.filesystemRoots?.workspace).toBe('/tmp/workspace');
            const response = await prepared.services.__backgroundServiceProcessLocal.http!.request({ url: 'https://example.test/data', redirect: 'error' }, {}, {
                request: async (_request, options) => ({ status: 200, finalUrl: 'https://example.test/data', headers: {}, body: new Uint8Array([options?.validatedAddresses?.length ?? 0]) }),
                openWebSocket: async () => { throw new Error('not requested'); },
            });
            expect(revalidated).toBe(true);
            expect(response.body).toEqual(new Uint8Array([1]));
        } finally { controller.abort(); await host.dispose(); }
    });

    it('fails closed without availability evidence while preserving explicitly bound private roots', async () => {
        const owner = createBackgroundServiceProcessServices({ metadata: {}, signal: new AbortController().signal,
            clientServices: { storage: { daemon: { get: async () => 'bypassed' } }, memory: { read: async () => 7 } },
        });
        expect(owner.services.availability('storage').status).toBe('unavailable');
        expect(() => owner.services.storage.daemon.get('key')).toThrow();
        expect(owner.services.memory).toMatchObject({ read: expect.any(Function) });
        expect(owner.services.availability('notifications').status).toBe('unavailable');
        await owner.dispose();
    });

    it('uses canonical filesystem policy and retires local operations when the child run settles', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-process-services-'));
        const binding = createPluginInvocationServiceBinding('occurrence', 'binding');
        const owner = createBackgroundServiceProcessServices({
            metadata: { plugin: { id: 'fixture', version: '1.0.0' }, contribution: { id: 'worker', qualifiedId: 'fixture/backgroundServices/worker' } },
            signal: new AbortController().signal, clientServices: { __backgroundServiceProcessLocal: { async writeLog() {} } },
            localPolicy: { binding: { ...binding, availability: { ...binding.availability, logger: 'available', fs: 'available' }, filesystemScopes: [{ root: 'pluginData', access: ['read', 'write'] }] },
                filesystemRoots: { pluginData: directory, workspace: directory, projects: [] },
            },
        });
        try {
            expect(owner.services.availability('fs').status).toBe('available');
            await owner.services.fs.writeFile({ root: 'pluginData', relativePath: 'row' }, new Uint8Array([1, 2]));
            expect(await owner.services.fs.readFile({ root: 'pluginData', relativePath: 'row' })).toEqual(new Uint8Array([1, 2]));
            await expect(owner.services.fs.readFile({ root: 'pluginData', relativePath: '../outside' })).rejects.toThrow();
            await owner.dispose();
            await expect(owner.services.fs.readFile({ root: 'pluginData', relativePath: 'row' })).rejects.toThrow();
        } finally { await owner.dispose(); await rm(directory, { force: true, recursive: true }); }
    });
});
