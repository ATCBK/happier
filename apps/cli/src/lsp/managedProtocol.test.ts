import { describe, expect, it } from 'vitest';
import { basename, resolve, join } from 'node:path';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { withTempDir } from '@/testkit/fs/tempDir';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { writeCommittedLocalPathPluginFixture } from '@/plugins/store/state.testkit';
import { PluginStateFileV1Schema } from '@/plugins/store/state';
import { parseProcessOwnerTag } from '@/processes/ownerTag';
import { DEFAULT_JSON_RPC_MAX_FRAME_BYTES } from '@/plugins/runtime/exec/jsonRpc';
import { readSupervisedPluginProcessIdForHost } from '@/plugins/runtime/exec/processSupervisor';
import { isPidAlive } from '@/testkit/process/spawn';
import { createLanguageServerProtocolOpener } from './managedProtocol';
import { createLanguageServerDefinitions } from './languageServerDefinitions';

describe('managed language server protocol', () => {
    it('launches an installed declaration and accepts native replies larger than a machine transport page', async () => {
        await withTempDir('happier-lsp-managed-', async rootPath => {
            const pluginId = 'fixture.language';
            const pluginRoot = join(rootPath, 'plugin');
            const manifestPath = join(pluginRoot, '.happier-plugin/plugin.json');
            const logPath = join(rootPath, 'process.json');
            await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
            await writeFile(manifestPath, JSON.stringify({ schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Fixture',
                runtime: { apiVersion: 1 }, contributes: {
                    languageServers: [{ id: 'language', title: 'Fixture', languageIds: { fixture: 'fixture' },
                        executable: { kind: 'systemTool', id: 'native' }, args: [resolve('src/lsp/__fixtures__/managedProtocol.cjs'), logPath] }],
                    systemTools: [{ id: 'native', title: 'Fixture native executable', executableNames: [basename(process.execPath)] }],
                },
            }));
            const happyHomeDir = join(rootPath, 'home');
            const installed = PluginStateFileV1Schema.parse({
                t: 'happier_plugin_state_v1', schemaVersion: 1, plugins: { [pluginId]: {
                    source: { kind: 'path', locator: pluginRoot, trustPolicy: 'local_trusted', installPolicy: 'link', resolvedPath: pluginRoot, manifestPath },
                    compatibility: { status: 'compatible', diagnostics: [] },
                    install: { mode: 'link', manifestVersion: '1.0.0', installedPath: null }, state: { enabled: true },
                } },
            }).plugins[pluginId];
            if (!installed) throw new Error('Installed fixture record is absent');
            await writeCommittedLocalPathPluginFixture({ happyHomeDir, pluginId, sourceRootPath: pluginRoot, plugin: installed });
            const registry = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir, pluginIds: [pluginId],
            });
            const controller = createPluginReloadController({ resolveRuntimeRegistry: async () => registry });
            const openProtocol = createLanguageServerProtocolOpener({ acquireRuntimeRegistry: () => controller.acquireRuntimeRegistry() });
            const definition = createLanguageServerDefinitions({ readCurrentContributionRegistry: () => registry.contributes })
                .readLanguageServerDefinitions().find(candidate => candidate.pluginId === pluginId);
            if (!definition) throw new Error('Installed language-server definition was not projected');
            const processOwner = { kind: 'service', serviceId: `lsp:${definition.id}:123456789abc` } as const;
            const handle = await openProtocol({
                definition,
                rootPath, processOwner, signal: new AbortController().signal,
            });
            const pid = readSupervisedPluginProcessIdForHost(handle.process);
            if (pid === null) throw new Error('Language-server process identity is unavailable');
            try {
                expect(await handle.client.request('echo', { value: 'héllo' })).toEqual({ value: 'héllo' });
                const characters = 384 * 1024;
                expect(await handle.client.request('largeReply', { characters })).toEqual({ value: 'x'.repeat(characters) });
                const facts = JSON.parse(await readFile(logPath, 'utf8')) as { cwd: string; owner: string };
                expect(facts.cwd).toBe(await realpath(rootPath));
                expect(parseProcessOwnerTag(facts.owner)?.owner).toEqual(processOwner);
                await expect(handle.client.request('largeReply', { characters: DEFAULT_JSON_RPC_MAX_FRAME_BYTES + 1 }))
                    .rejects.toMatchObject({ code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR' });
            } finally { await handle.dispose(); }
            expect((await handle.wait()).termination.observed.kind).not.toBe('failed');
            expect(isPidAlive(pid)).toBe(false);
            await controller.shutdown();
        });
    });
});
