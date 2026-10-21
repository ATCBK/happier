import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import {
    DaemonLspQueryResponseSchema, DaemonLspSyncResponseSchema,
    DaemonLspWatchResponseSchema, DaemonLspRestartResponseSchema,
} from '@happier-dev/protocol/machines/languageIntelligence';
import { getFileLanguageFromPath } from '@happier-dev/protocol/machines/fileLanguage';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { writeCommittedLocalPathPluginFixture } from '@/plugins/store/state.testkit';
import { PluginStateFileV1Schema } from '@/plugins/store/state';
import { registerLanguageIntelligenceHandlers } from '@/rpc/handlers/languageIntelligence';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createCodeIntelligenceController } from '../../../ui/sources/sync/domains/workspaces/languageIntelligence/createCodeIntelligenceController';
import { createLanguageServerHost } from './languageServerHost';
import { createLanguageServerProtocolOpener } from './managedProtocol';

describe('installed external language through UI and Action ingress', () => {
    it.each(['ui', 'action'] as const)('uses the declared novel LSP id through the real %s path without claiming plain text', async ingress => {
        await withTempDir('happier-lsp-external-language-', async rootPath => {
            const pluginId = 'fixture.novel-language';
            const pluginRoot = join(rootPath, 'plugin');
            const manifestPath = join(pluginRoot, '.happier-plugin/plugin.json');
            const logPath = join(rootPath, 'messages.jsonl');
            const path = 'example.happier-novel-language';
            const text = 'novelSymbol';
            const lspLanguage = 'fixture-novel-lsp';
            await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
            await writeFile(logPath, '');
            await writeFile(join(rootPath, path), text);
            await writeFile(join(rootPath, 'notes.txt'), text);
            await writeFile(manifestPath, JSON.stringify({ schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Novel language',
                runtime: { apiVersion: 1 }, contributes: {
                    languageServers: [{ id: 'language', title: 'Novel language', languageIds: { 'fixture-novel': lspLanguage },
                        filePatterns: ['*.happier-novel-language'], executable: { kind: 'systemTool', id: 'native' },
                        args: [resolve('src/lsp/__fixtures__/languageServer.cjs'), logPath, JSON.stringify({ requiredLanguageId: lspLanguage })] }],
                    // The scripted child is the external process boundary; the resolver, Exec, codec and supervisor remain real.
                    systemTools: [{ id: 'native', title: 'Fixture executable', executableNames: [basename(process.execPath)] }],
                },
            }));
            const happyHomeDir = join(rootPath, 'home');
            const installed = PluginStateFileV1Schema.parse({ t: 'happier_plugin_state_v1', schemaVersion: 1, plugins: { [pluginId]: {
                source: { kind: 'path', locator: pluginRoot, trustPolicy: 'local_trusted', installPolicy: 'link', resolvedPath: pluginRoot, manifestPath },
                compatibility: { status: 'compatible', diagnostics: [] },
                install: { mode: 'link', manifestVersion: '1.0.0', installedPath: null }, state: { enabled: true },
            } } }).plugins[pluginId];
            if (!installed) throw new Error('Installed fixture record is absent');
            await writeCommittedLocalPathPluginFixture({ happyHomeDir, pluginId, sourceRootPath: pluginRoot, plugin: installed });
            const registry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir, pluginIds: [pluginId] });
            const reload = createPluginReloadController({ resolveRuntimeRegistry: async () => registry });
            const host = createLanguageServerHost({ readCurrentContributionRegistry: () => registry.contributes,
                openProtocol: createLanguageServerProtocolOpener({ acquireRuntimeRegistry: () => reload.acquireRuntimeRegistry() }) });
            const handlers = new Map<string, RpcHandler>();
            const registrar: RpcHandlerRegistrar = { registerHandler: (method, handler) => { handlers.set(method, handler); } };
            registerLanguageIntelligenceHandlers(registrar, rootPath, { host, accessPolicy: { kind: 'restrictedRoots', roots: [rootPath] } });
            const call = async (method: string, request: unknown, signal?: AbortSignal) => {
                const handler = handlers.get(method);
                if (!handler) throw new Error(`Missing registered ${method}`);
                return handler(request, signal ? { signal } : undefined);
            };
            const messages = async () => (await readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean)
                .map(line => JSON.parse(line) as { method?: string; params?: { textDocument?: { languageId?: string } } });
            let controller: ReturnType<typeof createCodeIntelligenceController> | undefined;
            try {
                expect(getFileLanguageFromPath(path)).toBeNull();
                if (ingress === 'action') {
                    // This partial dependency object is the real remote Machine transport boundary.
                    const deps = { languageIntelligenceQuery: async ({ request }, context) =>
                        DaemonLspQueryResponseSchema.parse(await call(RPC_METHODS.DAEMON_LSP_QUERY, request, context?.signal))
                    } satisfies Pick<ActionExecutorDeps, 'languageIntelligenceQuery'>;
                    const executor = createActionExecutor(deps as ActionExecutorDeps);
                    expect(await executor.execute('code.hover.get', { machineId: 'machine', rootPath, path, line: 1, symbol: text }, { surface: 'agent' }))
                        .toMatchObject({ ok: true, result: { status: 'ok', fileHash: createHash('sha256').update(text).digest('hex'),
                            sections: [{ serverId: `${pluginId}/language`, markdown: text }] } });
                    expect(await executor.execute('code.hover.get', { machineId: 'machine', rootPath, path: 'notes.txt', line: 1, symbol: text }, { surface: 'agent' }))
                        .toMatchObject({ ok: true, result: { status: 'unavailable', reason: 'no_capable_server' } });
                } else {
                    controller = createCodeIntelligenceController({ scope: { serverId: 'home', machineId: 'machine', rootPath }, path,
                        languageId: getFileLanguageFromPath(path) ?? 'text', getText: () => text,
                        accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true,
                            onRetire: () => ({ dispose() {} }) },
                        query: async () => { throw new Error('A capable external server must not use name-search fallback'); },
                        openLocation() {}, languageServer: {
                            sync: async (request, signal) => DaemonLspSyncResponseSchema.parse(await call(RPC_METHODS.DAEMON_LSP_SYNC, request, signal)),
                            query: async (request, signal) => DaemonLspQueryResponseSchema.parse(await call(RPC_METHODS.DAEMON_LSP_QUERY, request, signal)),
                            watch: async (request, signal) => DaemonLspWatchResponseSchema.parse(await call(RPC_METHODS.DAEMON_LSP_WATCH, request, signal)),
                            restart: async signal => DaemonLspRestartResponseSchema.parse(await call(RPC_METHODS.DAEMON_LSP_RESTART, { rootPath }, signal)),
                        },
                    });
                    await controller.outline();
                    expect(await messages()).toEqual([]);
                    await controller.hover({ line: 0, character: 0 });
                    expect(controller.getSnapshot()).toMatchObject({ status: 'ready', mode: 'server',
                        result: { status: 'ok', sections: [{ serverId: `${pluginId}/language`, markdown: text }] } });
                    expect(await call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'open', path: 'notes.txt', languageId: 'text', text, version: 1, unsaved: false } }))
                        .toMatchObject({ status: 'unavailable', reason: 'no_capable_server' });
                    controller.dispose();
                    await vi.waitFor(async () => expect((await messages()).some(message => message.method === 'textDocument/didClose')).toBe(true));
                }
                expect((await messages()).filter(message => message.method === 'textDocument/didOpen'))
                    .toMatchObject([{ params: { textDocument: { languageId: lspLanguage } } }]);
            } finally {
                controller?.dispose();
                await host.dispose();
                await reload.shutdown();
            }
        });
    });
});
