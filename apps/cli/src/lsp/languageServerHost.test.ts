import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { DaemonLspQueryRequestSchema, DaemonLspQueryResponseSchema, DaemonLspSyncResponseSchema, DaemonLspWatchResponseSchema } from '@happier-dev/protocol/machines/languageIntelligence';
import { DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_RAW_PAYLOAD_BYTES } from '@happier-dev/protocol/features/payload/capabilities/machineTunnelCapabilities';
import { MachineResourcesPolicyGetResultV1Schema } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';
import type { MachineResourcesPolicyReader } from '@/processes/toolIdleTimeouts';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { DEFAULT_JSON_RPC_MAX_FRAME_BYTES } from '@/plugins/runtime/exec/jsonRpc';
import { registerLanguageIntelligenceHandlers } from '@/rpc/handlers/languageIntelligence';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createLanguageServerHost, pageLanguageServerReferences } from './languageServerHost';
import type { PluginProtocolClientHandle } from '@happier-dev/plugin-sdk/exec/protocol-clients';
import { readSupervisedPluginProcessIdForHost } from '@/plugins/runtime/exec/processSupervisor';
import { isPidAlive } from '@/testkit/process/spawn';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { DaemonLspApplyResponseSchema } from '@happier-dev/protocol/machines/languageIntelligence';
import { pathToFileURL } from 'node:url';
import { buildWorkspaceFileRestoreOperation } from '@happier-dev/protocol/machines/workspaceFilesReplace';
import { applyWorkspaceFileReplace } from '@/rpc/handlers/workspaceFileReplace';
import type { ResolvedLanguageServerContribution } from '@/plugins/projection/registry/types';
import { readLspObject } from './languageServerResults';
import { createCodeIntelligenceController } from '../../../ui/sources/sync/domains/workspaces/languageIntelligence/createCodeIntelligenceController';
// Filesystem scheduling is the external boundary in the acquire/close regressions.
vi.mock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    return { ...actual, readFile: vi.fn(actual.readFile) };
});
async function fixture(rootPath: string, count = 1, behavior: Record<string, unknown> = {}, rootMarkers?: readonly string[], readPolicy?: MachineResourcesPolicyReader,
    definitionOverrides?: readonly Partial<ResolvedLanguageServerContribution['definition']>[]) {
    const protocolHandles: PluginProtocolClientHandle<'jsonRpc'>[] = [];
    const log = join(rootPath, 'messages.jsonl');
    await writeFile(log, '');
    const registryFor = (definitionCount: number) => createResolvedContributionRegistry({ languageServers: Array.from({ length: definitionCount }, (_, index) => ({
            provenance: 'external' as const, source: { kind: 'path' as const }, pluginId: 'fixture', identity: { pluginId: 'fixture', localId: `server${index}` }, manifestPath: join(rootPath, 'plugin.json'),
            definition: { id: `server${index}`, title: `Fixture ${index}`, languageIds: { typescript: 'typescript', tsx: 'typescriptreact' }, filePatterns: ['**/*.ts', '**/*.tsx'], ...(rootMarkers ? { rootMarkers: [...rootMarkers] } : {}), executable: { kind: 'systemTool' as const, id: 'server' }, args: [], initializationOptions: { userPreferences: { tsserver: { automaticTypeAcquisition: { enabled: false } } }, disablePushDiagnostics: true }, ...definitionOverrides?.[index] },
        })) });
    let registry = registryFor(count);
    const host = createLanguageServerHost({ readCurrentContributionRegistry: () => registry, readPolicy, async openProtocol(input) {
            // The OS executable/protocol child is the system boundary; host, catalog, codec and supervisor stay real.
            const service = createStablePluginExecService({ allowedExecutables: [input.definition.executable], signal: input.signal, processOwner: input.processOwner, isOccurrenceCurrent: () => !input.signal.aborted,
                resolveExecutable: async () => behavior.nativeTypeScript ? { command: resolve('../../node_modules/@typescript/typescript-linux-x64/lib/tsc'), args: ['--lsp', '--stdio'] }
                    : { command: process.execPath, args: [resolve('src/lsp/__fixtures__/languageServer.cjs'), log, JSON.stringify({ ...readLspObject(input.definition.initializationOptions), ...behavior })] }, resolvePath: async () => rootPath });
            const protocol = await service.clients.spawn({ kind: 'jsonRpc', framing: 'contentLength', cancellationMethod: '$/cancelRequest', maxFrameBytes: DEFAULT_JSON_RPC_MAX_FRAME_BYTES, launch: { executable: input.definition.executable, cwd: rootPath } });
            protocolHandles.push(protocol);
            return protocol;
        } });
    const handlers = new Map<string, RpcHandler>();
    const registrar: RpcHandlerRegistrar = { registerHandler: (method, handler) => { handlers.set(method, handler); } };
    registerLanguageIntelligenceHandlers(registrar, rootPath, { host, accessPolicy: { kind: 'restrictedRoots', roots: [rootPath] } });
    const call = async (method: string, input: unknown, signal?: AbortSignal) => {
        const handler = handlers.get(method);
        if (!handler)
            throw new Error('Missing production LSP handler');
        return await handler(input, signal ? { signal } : undefined);
    };
    const open = (path: string, text: string, version = 1, unsaved = false) => call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'open', path, languageId: 'typescript', version, text, unsaved } });
    const query = (kind: string, path = 'a.ts', extra: Record<string, unknown> = {}) => call(RPC_METHODS.DAEMON_LSP_QUERY, { rootPath, path, kind, ...extra });
    const deps = { languageIntelligenceQuery: async ({ request }, context) => DaemonLspQueryResponseSchema.parse(await call(RPC_METHODS.DAEMON_LSP_QUERY, request, context.signal)),
        languageIntelligenceApply: async ({ request }, context) => DaemonLspApplyResponseSchema.parse(await host.apply(request, { signal: context.signal })),
        workspaceFilesReplace: async ({ machineId: _machineId, ...request }, context) => applyWorkspaceFileReplace(request, rootPath, { kind: 'restrictedRoots', roots: [rootPath] }, context.signal ? { signal: context.signal } : undefined),
    } satisfies Pick<ActionExecutorDeps, 'languageIntelligenceQuery' | 'languageIntelligenceApply' | 'workspaceFilesReplace'>;
    const executor = createActionExecutor(deps as ActionExecutorDeps);
    return { host, open, query, call, executor, protocolHandles, setDefinitionCount: (definitionCount: number) => { registry = registryFor(definitionCount); }, messages: async () => String(await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>) };
}
describe('language intelligence composed host', () => {
    it.each([false, true])('reacquires a lost daemon document and diagnostic revision after reconnect (offline edit=%s)', async offlineEdit => {
        await withTempDir('happier-lsp-reconnect-', async rootPath => {
            let text = 'broken';
            let unsaved = false;
            await writeFile(join(rootPath, 'a.ts'), text);
            let active = await fixture(rootPath);
            const hosts = [active.host];
            let online = true;
            let transport = new AbortController();
            let holdOldHover = false;
            let releaseOldHover: (() => void) | undefined;
            let oldHover: Promise<void> | undefined;
            let markOldResponse!: () => void;
            const oldResponseReady = new Promise<void>(resolve => { markOldResponse = resolve; });
            // Only the Machine transport disappears/reconnects. Both daemon
            // instances use real registration, lifecycle, codec and native children.
            const call = async (method: string, request: unknown, signal?: AbortSignal) => {
                if (!online) throw new Error('Machine disconnected');
                const target = active;
                const response = await target.call(method, request, signal ? AbortSignal.any([signal, transport.signal]) : transport.signal);
                if (!online || target !== active) throw new Error('Machine disconnected');
                // A valid packet can already be buffered when cancellation or
                // reconnect overtakes its delivery. Keep that late packet real.
                if (holdOldHover && method === RPC_METHODS.DAEMON_LSP_QUERY && DaemonLspQueryRequestSchema.parse(request).kind === 'hover') {
                    holdOldHover = false;
                    await new Promise<void>(resolve => { releaseOldHover = resolve; markOldResponse(); });
                }
                return response;
            };
            const controller = createCodeIntelligenceController({
                scope: { serverId: 'home', machineId: 'machine', rootPath }, path: 'a.ts', languageId: 'typescript',
                accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true,
                    onRetire: () => ({ dispose() {} }) },
                getText: () => text, getUnsaved: () => unsaved,
                query: async () => { throw new Error('A capable server must not use name-search fallback'); }, openLocation() {},
                languageServer: {
                    sync: async (request, signal) => DaemonLspSyncResponseSchema.parse(await call(RPC_METHODS.DAEMON_LSP_SYNC, request, signal)),
                    query: async (request, signal) => DaemonLspQueryResponseSchema.parse(await call(RPC_METHODS.DAEMON_LSP_QUERY, request, signal)),
                    watch: async (request, signal) => DaemonLspWatchResponseSchema.parse(await call(RPC_METHODS.DAEMON_LSP_WATCH, request, signal)),
                    restart: async () => { throw new Error('Recovery must not require a language-service restart'); },
                },
            });
            try {
                for (let index = 0; index < 8; index++) await controller.checkProblems();
                await vi.waitFor(() => expect(controller.getSnapshot().diagnostics).toMatchObject({ state: 'ready', count: 1, items: [{ message: text }] }));
                const oldRevision = controller.getDiagnosticsProjection().revision;
                const oldPids = active.protocolHandles.map(handle => readSupervisedPluginProcessIdForHost(handle.process)).filter((pid): pid is number => typeof pid === 'number');
                expect(oldPids).toHaveLength(1);
                holdOldHover = true;
                oldHover = controller.hover({ line: 0, character: 2 });
                await oldResponseReady;
                online = false;
                transport.abort();
                await active.host.dispose();
                await vi.waitFor(async () => expect(await Promise.all(oldPids.map(isPidAlive))).toEqual([false]));
                await controller.checkProblems();
                expect(controller.getSnapshot()).toMatchObject({ status: 'unavailable', reason: 'transport_failed' });
                if (offlineEdit) { text = 'brokenOfflineDraft'; unsaved = true; }

                active = await fixture(rootPath);
                hosts.push(active.host);
                transport = new AbortController();
                online = true;
                await controller.checkProblems();
                expect(controller.getSnapshot()).toMatchObject({ status: 'ready', result: { status: 'ok', kind: 'diagnostics', diagnostics: [{ message: text }] } });
                releaseOldHover?.();
                await oldHover;
                expect(controller.getSnapshot()).toMatchObject({ status: 'ready', result: { kind: 'diagnostics', diagnostics: [{ message: text }] } });
                await vi.waitFor(() => expect(controller.getSnapshot().diagnostics).toMatchObject({ state: 'ready', count: 1, items: [{ message: text }] }));
                expect(controller.getDiagnosticsProjection().revision).toBeLessThan(oldRevision);
                await controller.hover({ line: 0, character: 2 });
                expect(controller.getSnapshot()).toMatchObject({ status: 'ready', result: { kind: 'hover', sections: [{ markdown: text }] } });
                await controller.checkProblems();
                expect((await active.messages()).filter(message => message.method === 'textDocument/didOpen')).toHaveLength(1);
                const pids = active.protocolHandles.map(handle => readSupervisedPluginProcessIdForHost(handle.process)).filter((pid): pid is number => typeof pid === 'number');
                expect(pids).toHaveLength(1);
                controller.dispose();
                await vi.waitFor(async () => expect(await Promise.all(pids.map(isPidAlive))).toEqual([false]));
                expect(active.host.readProcessRoots()).toEqual([]);
            } finally {
                releaseOldHover?.();
                await oldHover;
                controller.dispose();
                await Promise.all(hosts.map(host => host.dispose()));
            }
        });
    });
    it.skipIf(process.env.HAPPIER_NATIVE_LSP_SMOKE !== '1')('runs native TypeScript 7.0.2 semantic rename, importer move, quick fix and guarded Undo', async () => {
        expect(JSON.parse(await readFile(resolve('../../node_modules/@typescript/typescript-linux-x64/package.json'), 'utf8'))).toMatchObject({ version: '7.0.2' });
        await withTempDir('happier-native-lsp-semantic-', async rootPath => {
            const source = 'export const greet = () => "hello";\n';
            const importer = 'import { greet } from "./a";\nexport const value = greet();\n';
            const broken = 'greet();\n';
            await writeFile(join(rootPath, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, module: 'esnext', target: 'esnext', moduleResolution: 'bundler' }, include: ['*.ts'] }));
            await writeFile(join(rootPath, 'a.ts'), source);
            await writeFile(join(rootPath, 'b.ts'), importer);
            await writeFile(join(rootPath, 'fix.ts'), broken);
            const undo = async (f: Awaited<ReturnType<typeof fixture>>, result: unknown) => {
                const parsed = DaemonLspApplyResponseSchema.parse(result);
                if (!('ok' in parsed) || !parsed.ok) throw new Error('Native operation did not return writer receipts');
                expect(parsed.results.every(file => file.status === 'replaced' && !file.reason)).toBe(true);
                const restored = await f.executor.execute('workspace.files.replace', { machineId: 'machine', rootPath,
                    operation: buildWorkspaceFileRestoreOperation(parsed.results) }, { surface: 'ui', authority: 'present_user' });
                expect(restored).toMatchObject({ ok: true, result: { ok: true } });
            };
            for (const scenario of ['symbol', 'file', 'fix'] as const) {
                const f = await fixture(rootPath, 1, { nativeTypeScript: true });
                try {
                    const target = { machineId: 'machine', rootPath, path: scenario === 'fix' ? 'fix.ts' : 'a.ts' };
                    if (scenario === 'fix') {
                        await f.open('fix.ts', broken, 7, true);
                        expect(await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'snapshot', path: 'fix.ts', languageId: 'typescript', version: 8, text: broken, unsaved: false } }))
                            .toMatchObject({ status: 'ok' });
                        expect(await f.query('diagnostics', 'fix.ts', { text: 'disk' }))
                            .toMatchObject({ status: 'ok', diagnostics: [{ code: 2304 }] });
                    }
                    const previewResult = await f.executor.execute(scenario === 'symbol' ? 'code.rename.preview' : scenario === 'file' ? 'code.file.rename.preview' : 'code.codeActions.list',
                        scenario === 'symbol' ? { ...target, line: 1, symbol: 'greet', newName: 'salute' }
                            : scenario === 'file' ? { ...target, newPath: 'moved.ts' } : { ...target, line: 1, symbol: 'greet' }, { surface: 'agent' });
                    if (!previewResult.ok) throw new Error(`Native ${scenario} preview failed`);
                    const preview = DaemonLspQueryResponseSchema.parse(previewResult.result);
                    if (preview.status !== 'ok') throw new Error(`Native ${scenario} preview was ${preview.status}`);
                    let applied;
                    if (scenario === 'fix') {
                        if (preview.kind !== 'codeActions') throw new Error('Expected native code actions');
                        const action = preview.actions.find(action => action.files.some(file => file.path === 'fix.ts' && file.edits.some(edit => edit.text.includes('import') && edit.text.includes('greet'))));
                        expect(action).toBeDefined();
                        if (!action) throw new Error('Native missing-import quick fix was not offered');
                        applied = await f.executor.execute('code.codeAction.apply', { ...target, operation: { kind: 'codeAction', action, expectedHash: preview.fileHash! } }, { surface: 'ui', authority: 'present_user' });
                    } else {
                        if (preview.kind !== 'rename' && preview.kind !== 'willRenameFiles') throw new Error('Expected native rename edits');
                        applied = await f.executor.execute(scenario === 'symbol' ? 'code.rename.apply' : 'code.file.rename.apply', { ...target, files: preview.files }, { surface: 'ui', authority: 'present_user' });
                    }
                    if (!applied.ok) throw new Error(`Native ${scenario} apply failed`);
                    if (scenario === 'symbol') expect(await readFile(join(rootPath, 'b.ts'), 'utf8')).toContain('salute');
                    if (scenario === 'file') expect(await readFile(join(rootPath, 'b.ts'), 'utf8')).toContain('./moved');
                    if (scenario === 'fix') {
                        expect(await readFile(join(rootPath, 'fix.ts'), 'utf8')).toContain('import');
                        expect(await f.query('diagnostics', 'fix.ts', { text: 'disk' })).toMatchObject({ status: 'ok', diagnostics: [] });
                    }
                    await undo(f, applied.result);
                    expect(await readFile(join(rootPath, 'a.ts'), 'utf8')).toBe(source);
                    expect(await readFile(join(rootPath, 'b.ts'), 'utf8')).toBe(importer);
                    expect(await readFile(join(rootPath, 'fix.ts'), 'utf8')).toBe(broken);
                } finally { await f.host.dispose(); }
            }
        });
    });
    it('asks for quick fixes with fresh diagnostic context from the canonical pull owner', async () => {
        await withTempDir('happier-lsp-codeaction-context-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'broken');
            const f = await fixture(rootPath, 1, { semanticEdits: true, requireDiagnosticContext: true });
            try {
                await f.open('a.ts', 'broken');
                expect(await f.query('codeActions', 'a.ts', { text: 'disk', position: { line: 0, character: 0 } }))
                    .toMatchObject({ status: 'ok', actions: [{ title: 'Fix fixture' }] });
                expect(DaemonLspWatchResponseSchema.parse(await f.call(RPC_METHODS.DAEMON_LSP_WATCH, { rootPath })))
                    .toMatchObject({ diagnostics: { 'a.ts': { 'fixture/server0': { items: [{ code: 2322 }] } } } });
            } finally { await f.host.dispose(); }
        });
    });
    it('undoes direct edits then command edits on the same file and a source move through the restore Action', async () => {
        await withTempDir('happier-lsp-command-undo-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'old');
            await writeFile(join(rootPath, 'b.ts'), 'old');
            const f = await fixture(rootPath, 1, { semanticEdits: true, commandDirectEdits: true });
            try {
                const listed = DaemonLspQueryResponseSchema.parse(await f.query('codeActions', 'a.ts', { text: 'disk', position: { line: 0, character: 0 } }));
                if (listed.status !== 'ok' || listed.kind !== 'codeActions') throw new Error('Expected code actions');
                const outcome = await f.executor.execute('code.codeAction.apply', { machineId: 'machine', rootPath, path: 'a.ts',
                    operation: { kind: 'codeAction', action: listed.actions[0], expectedHash: listed.fileHash! },
                }, { surface: 'ui', authority: 'present_user' });
                if (!outcome.ok) throw new Error('Code action failed');
                const applied = DaemonLspApplyResponseSchema.parse(outcome.result);
                if (!('ok' in applied) || !applied.ok) throw new Error('Expected writer receipts');
                expect(applied.results.map(result => result.path)).toEqual(['b.ts', 'a.ts', 'b.ts']);
                expect(await readFile(join(rootPath, 'b.ts'), 'utf8')).toBe('fixed');
                expect(await readFile(join(rootPath, 'moved.ts'), 'utf8')).toBe('old');
                expect(await f.executor.execute('workspace.files.replace', { machineId: 'machine', rootPath,
                    operation: buildWorkspaceFileRestoreOperation(applied.results),
                }, { surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: true, result: { ok: true, results: [{ status: 'restored' }, { status: 'restored' }, { status: 'restored' }] } });
                expect(await readFile(join(rootPath, 'a.ts'), 'utf8')).toBe('old');
                expect(await readFile(join(rootPath, 'b.ts'), 'utf8')).toBe('old');
                await expect(readFile(join(rootPath, 'moved.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
            } finally { await f.host.dispose(); }
        });
    });
    it('reports a command edit refusal even when the server acknowledges its command successfully', async () => {
        await withTempDir('happier-lsp-command-refusal-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'old');
            const f = await fixture(rootPath, 1, { semanticEdits: true, refuseCommandEdit: true });
            try {
                const listed = DaemonLspQueryResponseSchema.parse(await f.query('codeActions', 'a.ts', { text: 'disk', position: { line: 0, character: 0 } }));
                if (listed.status !== 'ok' || listed.kind !== 'codeActions') throw new Error('Expected code actions');
                expect(await f.host.apply({ rootPath, path: 'a.ts', operation: { kind: 'codeAction', action: listed.actions[0], expectedHash: listed.fileHash! } }))
                    .toMatchObject({ status: 'error', errorCode: 'request_failed' });
                expect(await readFile(join(rootPath, 'a.ts'), 'utf8')).toBe('old');
            } finally { await f.host.dispose(); }
        });
    });
    it('applies reviewed file renames and fresh server commands through Actions and the one guarded writer', async () => {
        await withTempDir('happier-lsp-semantic-apply-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'old');
            await writeFile(join(rootPath, 'b.ts'), 'old');
            const f = await fixture(rootPath, 1, { semanticEdits: true });
            try {
                const target = { machineId: 'machine', rootPath, path: 'a.ts' };
                const listed = await f.executor.execute('code.codeActions.list', { ...target, line: 1, symbol: 'old' }, { surface: 'agent' });
                expect(listed.ok).toBe(true);
                if (!listed.ok) throw new Error('Code actions unavailable');
                const preview = DaemonLspQueryResponseSchema.parse(listed.result);
                if (preview.status !== 'ok' || preview.kind !== 'codeActions') throw new Error('Expected code actions');
                expect(preview.actions[0]).toMatchObject({ hasCommand: true });
                expect(preview.actions[0]).not.toHaveProperty('command');
                const input = { ...target, operation: { kind: 'codeAction' as const, action: preview.actions[0], expectedHash: preview.fileHash! } };
                const applied = await f.executor.execute('code.codeAction.apply', input, { surface: 'ui', authority: 'present_user' });
                expect(applied).toMatchObject({ ok: true, result: { ok: true, results: [{ path: 'b.ts', status: 'replaced', edits: [{ originalText: 'old', insertText: 'fixed' }] }] } });
                expect(await readFile(join(rootPath, 'b.ts'), 'utf8')).toBe('fixed');
                expect(f.protocolHandles).toHaveLength(2); // The apply reacquires a current server command after transient preview teardown.
                await writeFile(join(rootPath, 'b.ts'), 'old');
                const rename = await f.executor.execute('code.file.rename.preview', { ...target, newPath: 'moved.ts' }, { surface: 'agent' });
                if (!rename.ok) throw new Error('File rename unavailable');
                const edits = DaemonLspQueryResponseSchema.parse(rename.result);
                if (edits.status !== 'ok' || edits.kind !== 'willRenameFiles') throw new Error('Expected rename edits');
                expect(await f.executor.execute('code.file.rename.apply', { ...target, files: edits.files }, { surface: 'ui', authority: 'present_user' }))
                    .toMatchObject({ ok: true, result: { ok: true, results: [ { path: 'a.ts', renameTo: 'moved.ts', status: 'replaced' }, { path: 'b.ts', status: 'replaced' } ] } });
                expect(await readFile(join(rootPath, 'moved.ts'), 'utf8')).toBe('old');
                expect(await readFile(join(rootPath, 'b.ts'), 'utf8')).toBe('updated');
                await expect(readFile(join(rootPath, 'a.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
            } finally { await f.host.dispose(); }
        });
    });
    it('refuses unsolicited server writes and cancels a command without granting later edit authority', async () => {
        await withTempDir('happier-lsp-command-cancel-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'old');
            await writeFile(join(rootPath, 'b.ts'), 'old');
            const f = await fixture(rootPath, 1, { semanticEdits: true, delayCommand: true });
            try {
                await f.open('a.ts', 'old');
                expect(await f.protocolHandles[0].client.request('fixture/unsolicitedEdit', { uri: pathToFileURL(join(rootPath, 'b.ts')).href })).toEqual({ applied: false });
                const listed = DaemonLspQueryResponseSchema.parse(await f.query('codeActions', 'a.ts', { text: 'disk', position: { line: 0, character: 0 } }));
                if (listed.status !== 'ok' || listed.kind !== 'codeActions') throw new Error('Expected code actions');
                const abort = new AbortController();
                const applying = f.host.apply({ rootPath, path: 'a.ts', operation: { kind: 'codeAction', action: listed.actions[0], expectedHash: listed.fileHash! } }, { signal: abort.signal });
                await vi.waitFor(async () => expect((await f.messages()).some(message => message.method === 'workspace/executeCommand')).toBe(true));
                abort.abort();
                expect(await applying).toMatchObject({ status: 'error', errorCode: 'cancelled' });
                expect(await f.protocolHandles[0].client.request('fixture/unsolicitedEdit', { uri: pathToFileURL(join(rootPath, 'b.ts')).href })).toEqual({ applied: false });
                expect(await readFile(join(rootPath, 'b.ts'), 'utf8')).toBe('old');
                expect(await f.query('rename', 'a.ts', { text: 'disk', position: { line: 0, character: 0 }, newName: 'orderedInserts' }))
                    .toMatchObject({ status: 'ok', files: [{ path: 'a.ts', edits: [{ text: 'x' }, { text: 'x' }] }] });
            } finally { await f.host.dispose(); }
        });
    });
    it('previews semantic edits from the real server without writing and rejects unsafe edit sets', async () => {
        await withTempDir('happier-lsp-rename-', async rootPath => {
            const source = Buffer.from('old\r\n');
            await writeFile(join(rootPath, 'a.ts'), source);
            await writeFile(join(rootPath, 'b.ts'), 'old');
            const f = await fixture(rootPath, 1, { semanticEdits: true });
            try {
                const result = DaemonLspQueryResponseSchema.parse(await f.query('rename', 'a.ts', {
                    text: 'disk', position: { line: 0, symbol: 'old' }, newName: 'renamed',
                }));
                expect(result).toMatchObject({ status: 'ok', kind: 'rename', files: [
                    { path: 'a.ts', expectedHash: createHash('sha256').update(source).digest('hex'), edits: [{ text: 'renamed' }] },
                    { path: 'b.ts', edits: [{ text: 'renamed' }] },
                ] });
                expect(await readFile(join(rootPath, 'a.ts'))).toEqual(source);
                expect(await readFile(join(rootPath, 'b.ts'), 'utf8')).toBe('old');
                expect(await f.query('rename', 'a.ts', { text: 'disk', position: { line: 0, character: 0 }, newName: 'outside' }))
                    .toMatchObject({ status: 'error', errorCode: 'path_not_allowed' });
                expect(await f.query('rename', 'a.ts', { text: 'disk', position: { line: 0, character: 0 }, newName: 'overlap' }))
                    .toMatchObject({ status: 'error', errorCode: 'invalid_request' });
                await f.open('b.ts', 'dirty', 1, true);
                expect(await f.query('rename', 'a.ts', { text: 'disk', position: { line: 0, character: 0 }, newName: 'next' }))
                    .toMatchObject({ status: 'error', errorCode: 'unsaved_editor_changes' });
            } finally { await f.host.dispose(); }
        });
    });
    it.each(['closed', 'closing'] as const)('acquires an Action document after its selected sibling session is %s during the disk read', async phase => {
        await withTempDir('happier-lsp-acquire-close-', async rootPath => {
            const path = join(rootPath, 'a.ts');
            await writeFile(path, 'shared');
            const behavior = { delayHover: true, delayShutdown: phase === 'closing' };
            const f = await fixture(rootPath, 1, behavior);
            let releaseRead!: () => void;
            const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
            let enteredRead!: () => void;
            const reading = new Promise<void>(resolve => { enteredRead = resolve; });
            const nativeRead = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).readFile;
            const readSpy = vi.mocked(fsPromises.readFile);
            try {
                const target = { machineId: 'machine', rootPath, path: 'a.ts' };
                const hover = f.executor.execute('code.hover.get', { ...target, line: 1, character: 0 }, { surface: 'agent' });
                await vi.waitFor(async () => expect((await f.messages()).some(message => message.method === 'textDocument/hover')).toBe(true));
                // Gate only the OS disk read. Session selection, document custody,
                // Action admission, managed JSON-RPC and the child remain real.
                let blocked = false;
                readSpy.mockImplementation((async (...args: Parameters<typeof nativeRead>) => {
                    if (args[0] === path && !blocked) {
                        blocked = true;
                        enteredRead();
                        await readGate;
                    }
                    return await nativeRead(...args);
                }) as typeof nativeRead);
                const symbols = f.executor.execute('code.symbols.list', target, { surface: 'agent' });
                await reading;
                await f.protocolHandles[0].client.notify('fixture/release', { method: 'textDocument/hover' });
                if (phase === 'closed') await hover;
                else {
                    await vi.waitFor(async () => expect((await f.messages()).some(message => message.method === 'shutdown')).toBe(true));
                    expect(f.host.readProcessRoots()).toMatchObject([{ state: 'stopping', pid: expect.any(Number) }]);
                    behavior.delayShutdown = false;
                }
                releaseRead();
                if (phase === 'closing') {
                    await new Promise<void>(resolve => setImmediate(resolve));
                    await f.protocolHandles[0].client.notify('fixture/release', { method: 'shutdown' });
                }
                expect(await hover).toMatchObject({ ok: true, result: { status: 'ok', sections: [{ markdown: 'shared' }] } });
                expect.soft(await symbols).toMatchObject({ ok: true, result: { status: 'ok', kind: 'documentSymbols', symbols: [{ name: 'fixture' }] } });
                // The next ordinary Action must not inherit a stopped session.
                expect(await f.executor.execute('code.symbols.list', target, { surface: 'agent' }))
                    .toMatchObject({ ok: true, result: { status: 'ok', symbols: [{ name: 'fixture' }] } });
                expect(await f.host.watch({ rootPath })).toMatchObject({ status: 'ok', servers: [] });
            } finally {
                releaseRead();
                readSpy.mockImplementation(nativeRead);
                await f.host.dispose();
            }
        });
    });
    it.each(['cancelled', 'completed'] as const)('retains an overlapping transient query after its sibling is %s', async settlement => {
        await withTempDir('happier-lsp-transient-overlap-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'shared');
            const f = await fixture(rootPath, 1, { delayHover: true, delayDiagnostic: true });
            try {
                const abort = new AbortController();
                const first = f.call(RPC_METHODS.DAEMON_LSP_QUERY, { rootPath, path: 'a.ts', kind: 'diagnostics', text: 'disk' }, abort.signal);
                await vi.waitFor(async () => expect((await f.messages()).some(m => m.method === 'textDocument/diagnostic')).toBe(true));
                const second = f.query('hover', 'a.ts', { text: 'disk', position: { line: 0, character: 0 } });
                await vi.waitFor(async () => expect((await f.messages()).some(m => m.method === 'textDocument/hover')).toBe(true));
                if (settlement === 'cancelled') abort.abort();
                else await f.protocolHandles[0].client.notify('fixture/release', { method: 'textDocument/diagnostic' });
                expect(await first).toMatchObject(settlement === 'cancelled' ? { status: 'error', errorCode: 'cancelled' } : { status: 'ok' });
                const pid = readSupervisedPluginProcessIdForHost(f.protocolHandles[0].process);
                if (pid === null) throw new Error('Missing native language-server PID');
                expect(isPidAlive(pid)).toBe(true);
                await f.protocolHandles[0].client.notify('fixture/release', { method: 'textDocument/hover' });
                expect(await second).toMatchObject({ status: 'ok', sections: [{ markdown: 'shared' }] });
                await expect(f.protocolHandles[0].wait()).resolves.toBeDefined();
                expect(f.protocolHandles).toHaveLength(1);
            } finally { await f.host.dispose(); }
        });
    });
    it('preserves a new editor holder acquired while its previous holder closes natively', async () => {
        await withTempDir('happier-lsp-editor-reacquire-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'disk');
            const behavior = { delayShutdown: true };
            const f = await fixture(rootPath, 1, behavior);
            try {
                await f.open('a.ts', 'first', 1);
                const closing = f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'close', path: 'a.ts' } });
                await vi.waitFor(async () => expect((await f.messages()).some(message => message.method === 'shutdown')).toBe(true));
                expect(f.host.readProcessRoots()).toMatchObject([{ state: 'stopping' }]);
                behavior.delayShutdown = false;
                const opening = f.open('a.ts', 'editor', 9, true);
                await new Promise<void>(resolve => setImmediate(resolve));
                await f.protocolHandles[0].client.notify('fixture/release', { method: 'shutdown' });
                expect(await closing).toMatchObject({ status: 'ok' });
                expect(await opening).toMatchObject({ status: 'ok' });
                expect(await f.query('hover', 'a.ts', { position: { line: 0, character: 0 } }))
                    .toMatchObject({ status: 'ok', version: 9, sections: [{ markdown: 'editor' }] });
                expect(await f.query('hover', 'a.ts', { text: 'disk', position: { line: 0, character: 0 } }))
                    .toMatchObject({ status: 'error', errorCode: 'unsaved_editor_changes' });
                expect(await f.host.watch({ rootPath })).toMatchObject({ status: 'ok', servers: [{ state: 'ready' }] });
                await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'close', path: 'a.ts' } });
                expect(await f.host.watch({ rootPath })).toMatchObject({ status: 'ok', servers: [] });
            } finally { await f.host.dispose(); }
        });
    });
    it('preserves a current unsaved editor buffer opened during a default query disk read', async () => {
        await withTempDir('happier-lsp-editor-during-read-', async rootPath => {
            const path = join(rootPath, 'a.ts');
            await writeFile(path, 'disk');
            const f = await fixture(rootPath);
            let releaseRead!: () => void;
            const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
            let enteredRead!: () => void;
            const reading = new Promise<void>(resolve => { enteredRead = resolve; });
            const nativeRead = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).readFile;
            const readSpy = vi.mocked(fsPromises.readFile);
            try {
                let blocked = false;
                readSpy.mockImplementation((async (...args: Parameters<typeof nativeRead>) => {
                    if (args[0] === path && !blocked) {
                        blocked = true;
                        enteredRead();
                        await readGate;
                    }
                    return await nativeRead(...args);
                }) as typeof nativeRead);
                const hover = f.query('hover', 'a.ts', { position: { line: 0, character: 0 } });
                await reading;
                expect(await f.open('a.ts', 'editor', 9, true)).toMatchObject({ status: 'ok' });
                releaseRead();
                const result = await hover;
                expect.soft(result).toMatchObject({ status: 'ok', version: 9, sections: [{ markdown: 'editor' }] });
                expect.soft(result).not.toHaveProperty('fileHash');
                expect.soft(await f.query('hover', 'a.ts', { position: { line: 0, character: 0 } }))
                    .toMatchObject({ status: 'ok', version: 9, sections: [{ markdown: 'editor' }] });
                expect(await f.query('hover', 'a.ts', { text: 'disk', position: { line: 0, character: 0 } }))
                    .toMatchObject({ status: 'error', errorCode: 'unsaved_editor_changes' });
            } finally {
                releaseRead();
                readSpy.mockImplementation(nativeRead);
                await f.host.dispose();
            }
        });
    });
    it.each([1, 2])('forgets idle-reaped holder memberships before reopening %i definitions', async definitionCount => {
        await withTempDir('happier-lsp-idle-reopen-', async rootPath => {
            const policy = MachineResourcesPolicyGetResultV1Schema.parse({ status: 'ready', policy: { v: 1, processes: { toolIdleCloseMs: 1000 } }, revision: 0, source: 'stored' });
            await writeFile(join(rootPath, 'a.ts'), 'shared');
            const f = await fixture(rootPath, definitionCount, {}, undefined, () => policy);
            try {
                await f.open('a.ts', 'shared');
                await Promise.all(f.protocolHandles.map(handle => handle.wait()));
                await vi.waitFor(async () => expect(await f.call(RPC_METHODS.DAEMON_LSP_WATCH, { rootPath })).toMatchObject({ status: 'ok', servers: [] }));
                await f.open('a.ts', 'shared');
                const closed = await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'close', path: 'a.ts' } });
                expect(closed).toMatchObject({ status: 'ok', servers: [] });
                await Promise.all(f.protocolHandles.map(handle => handle.wait()));
                expect(f.protocolHandles).toHaveLength(definitionCount * 2);
            } finally { await f.host.dispose(); }
        });
    });
    it('honors a valid idle policy beyond the native timer delay without overflowing or replacing the child', async () => {
        await withTempDir('happier-lsp-long-idle-policy-', async rootPath => {
            const disabledPolicy = MachineResourcesPolicyGetResultV1Schema.parse({ status: 'ready', policy: { v: 1, processes: { toolIdleCloseMs: null } }, revision: 0, source: 'stored' });
            const longPolicy = MachineResourcesPolicyGetResultV1Schema.parse({ status: 'ready', policy: { v: 1, processes: { toolIdleCloseMs: 30 * 24 * 60 * 60 * 1000 } }, revision: 1, source: 'stored' });
            let policy = disabledPolicy;
            const warnings: string[] = [];
            const onWarning = (warning: Error) => { if (warning.name === 'TimeoutOverflowWarning') warnings.push(warning.message); };
            await writeFile(join(rootPath, 'a.ts'), 'shared');
            const f = await fixture(rootPath, 1, {}, undefined, () => policy);
            process.on('warning', onWarning);
            try {
                await f.open('a.ts', 'shared');
                expect(f.protocolHandles).toHaveLength(1);
                // Read the changed Machine policy after a real child is ready,
                // so timer behavior is observed across native protocol work.
                policy = longPolicy;
                for (let index = 0; index < 2; index++) {
                    expect(await f.query('hover', 'a.ts', { position: { line: 0, character: 0 } })).toMatchObject({ status: 'ok', sections: [{ markdown: 'shared' }] });
                    await new Promise<void>(done => setImmediate(done));
                }
                expect(f.protocolHandles).toHaveLength(1);
            } finally {
                policy = disabledPolicy;
                await f.host.dispose();
                await Promise.all(f.protocolHandles.map(handle => handle.wait()));
                process.removeListener('warning', onWarning);
            }
            expect(warnings).toEqual([]);
        });
    });
    it('serves real registered RPCs through the handshake, opts diagnostics in, and delivers watch replacements', async () => {
        await withTempDir('happier-lsp-composed-', async (rootPath) => {
            await writeFile(join(rootPath, 'a.ts'), 'broken');
            const f = await fixture(rootPath);
            try {
                const opened = DaemonLspSyncResponseSchema.parse(await f.open('a.ts', 'broken'));
                expect(opened).toMatchObject({ status: 'ok', capabilities: { hover: true, definition: true, diagnostics: 'pull' } });
                const hover = DaemonLspQueryResponseSchema.parse(await f.query('hover', 'a.ts', { position: { line: 0, symbol: 'broken' } }));
                expect(hover).toMatchObject({ status: 'ok', kind: 'hover', sections: [{ markdown: 'broken' }] });
                expect((await f.messages()).some(m => m.id === 'registration' && !m.method)).toBe(true);
                expect((await f.messages()).some(m => m.method === 'textDocument/diagnostic')).toBe(false);
                expect(await f.query('definition', 'a.ts', { position: { line: 0, character: 0 } })).toMatchObject({ status: 'ok', locations: [{ path: 'a.ts' }] });
                expect(await f.query('diagnostics')).toMatchObject({ status: 'ok', diagnostics: [{ path: 'a.ts', severity: 'error', message: 'broken' }] });
                const watch = DaemonLspWatchResponseSchema.parse(await f.call(RPC_METHODS.DAEMON_LSP_WATCH, { rootPath }));
                expect(watch).toMatchObject({ status: 'ok', diagnostics: { 'a.ts': { 'fixture/server0': { state: 'ready', version: 1, items: [{ message: 'broken' }] } } } });
                await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'change', path: 'a.ts', baseVersion: 1, version: 2, edit: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 6, text: 'fixed' }, unsaved: true } });
                expect(await f.query('diagnostics')).toMatchObject({ status: 'ok', diagnostics: [] });
                await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'close', path: 'a.ts' } });
                await expect(f.protocolHandles[0].wait()).resolves.toBeDefined();
            }
            finally {
                await f.host.dispose();
            }
        });
    });
    it('answers about raw disk bytes, refuses unsaved buffers, and reopens transient Action documents', async () => {
        await withTempDir('happier-lsp-disk-', async (rootPath) => {
            const bytes = Buffer.from('saved\r\n');
            await writeFile(join(rootPath, 'a.ts'), bytes);
            const f = await fixture(rootPath);
            try {
                const extra = { text: 'disk', position: { line: 0, symbol: 'saved' } };
                expect(await f.query('hover', 'a.ts', extra)).toMatchObject({ status: 'ok', fileHash: createHash('sha256').update(bytes).digest('hex'), sections: [{ markdown: 'saved\r\n' }] });
                expect(await f.query('hover', 'a.ts', extra)).toMatchObject({ status: 'ok' });
                expect(f.protocolHandles).toHaveLength(2);
                await f.open('a.ts', 'unsaved', 3, true);
                const previous = (await f.messages()).filter(m => m.method === 'textDocument/hover').length;
                expect(await f.query('hover', 'a.ts', extra)).toMatchObject({ status: 'error', errorCode: 'unsaved_editor_changes', diskHash: createHash('sha256').update(bytes).digest('hex') });
                expect((await f.messages()).filter(m => m.method === 'textDocument/hover')).toHaveLength(previous);
                expect(await f.query('hover', 'a.ts', { position: { line: 0, character: 0 } }))
                    .toMatchObject({ status: 'ok', version: 3, sections: [{ markdown: 'unsaved' }] });
                expect(await f.host.watch({ rootPath })).toMatchObject({ status: 'ok', servers: [{ state: 'ready' }] });
                expect(f.protocolHandles).toHaveLength(3);
                await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'snapshot', path: 'a.ts', languageId: 'typescript', version: 4, text: 'clean old', unsaved: false } });
                const changedBytes = Buffer.from('changed on disk\r\n');
                await writeFile(join(rootPath, 'a.ts'), changedBytes);
                expect(await f.query('hover', 'a.ts', { text: 'disk', position: { line: 0, character: 0 } })).toMatchObject({
                    status: 'ok', version: 5, fileHash: createHash('sha256').update(changedBytes).digest('hex'), sections: [{ markdown: 'changed on disk\r\n' }],
                });
                expect(await f.query('hover', 'a.ts', { position: { line: 0, character: 0 } })).toMatchObject({ status: 'ok', version: 5, sections: [{ markdown: 'changed on disk\r\n' }] });
            }
            finally {
                await f.host.dispose();
            }
        });
    });
    it('shares one process across packages and merges multiple definitions in canonical order', async () => {
        await withTempDir('happier-lsp-roots-', async (rootPath) => {
            await mkdir(join(rootPath, 'one'));
            await mkdir(join(rootPath, 'two'));
            await writeFile(join(rootPath, 'one/a.ts'), 'one');
            await writeFile(join(rootPath, 'two/b.ts'), 'two');
            const f = await fixture(rootPath, 2);
            try {
                await f.open('one/a.ts', 'one');
                await f.open('two/b.ts', 'two');
                expect(f.protocolHandles).toHaveLength(2);
                expect(await f.query('hover', 'one/a.ts', { position: { line: 0, character: 0 } })).toMatchObject({ status: 'ok', sections: [{ serverId: 'fixture/server0' }, { serverId: 'fixture/server1' }] });
                const definitions = DaemonLspQueryResponseSchema.parse(await f.query('definition', 'one/a.ts', { position: { line: 0, character: 0 } }));
                expect(definitions).toMatchObject({ status: 'ok', locations: [{ serverId: 'fixture/server0', path: 'one/a.ts' }] });
                if (definitions.status !== 'ok' || definitions.kind !== 'definition') throw new Error('Expected definition results');
                expect(definitions.locations).toHaveLength(1);
                const references = DaemonLspQueryResponseSchema.parse(await f.query('references', 'two/b.ts', { position: { line: 0, character: 0 } }));
                expect(references).toMatchObject({ status: 'ok', locations: [{ serverId: 'fixture/server0', path: 'two/b.ts', lineText: 'two' }] });
                if (references.status !== 'ok' || references.kind !== 'references') throw new Error('Expected reference results');
                expect(references.locations).toHaveLength(1);
                await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'close', path: 'one/a.ts' } });
                expect(await f.query('hover', 'two/b.ts', { position: { line: 0, character: 0 } })).toMatchObject({ status: 'ok', sections: [{ serverId: 'fixture/server0' }, { serverId: 'fixture/server1' }] });
                expect(f.protocolHandles).toHaveLength(2);
                await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'close', path: 'two/b.ts' } });
                await Promise.all(f.protocolHandles.map(handle => expect(handle.wait()).resolves.toBeDefined()));
            }
            finally {
                await f.host.dispose();
            }
        });
    });
    it('reports only document servers and capabilities in sync while watches aggregate the root', async () => {
        await withTempDir('happier-lsp-document-servers-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'typescript');
            await writeFile(join(rootPath, 'file.example'), 'example');
            const f = await fixture(rootPath, 2, {}, undefined, undefined, [
                { languageIds: { typescript: 'typescript' }, filePatterns: ['**/*.ts'], initializationOptions: { semanticEdits: true } },
                { languageIds: { example: 'example-lsp' }, filePatterns: ['**/*.example'] },
            ]);
            try {
                expect(await f.open('a.ts', 'typescript')).toMatchObject({ status: 'ok', servers: [{ serverId: 'fixture/server0' }], capabilities: { rename: true } });
                const sync = (op: Record<string, unknown>) => f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { path: 'file.example', ...op } });
                const explicit = DaemonLspSyncResponseSchema.parse(await sync({ op: 'open', languageId: 'example', text: 'example', version: 1, unsaved: false }));
                expect.soft(explicit).toMatchObject({ status: 'ok', servers: [{ serverId: 'fixture/server1' }], capabilities: { hover: true, rename: false } });
                const fallback = DaemonLspSyncResponseSchema.parse(await sync({ op: 'snapshot', languageId: 'text', text: 'example two', version: 2, unsaved: false }));
                expect.soft(fallback).toMatchObject({ status: 'ok', servers: [{ serverId: 'fixture/server1' }], capabilities: { rename: false } });
                expect.soft(await sync({ op: 'change', baseVersion: 2, version: 3, edit: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 7, text: 'changed' }, unsaved: true }))
                    .toMatchObject({ status: 'ok', servers: [{ serverId: 'fixture/server1' }], capabilities: { rename: false } });
                expect(await f.host.watch({ rootPath })).toMatchObject({ status: 'ok', servers: [{ serverId: 'fixture/server0' }, { serverId: 'fixture/server1' }] });
                const opened = (await f.messages()).filter(message => message.method === 'textDocument/didOpen');
                expect(opened).toContainEqual(expect.objectContaining({ params: { textDocument: expect.objectContaining({ languageId: 'example-lsp' }) } }));
                expect.soft(await sync({ op: 'close' })).toMatchObject({ status: 'ok', servers: [], capabilities: { hover: false } });
                expect(await f.host.watch({ rootPath })).toMatchObject({ status: 'ok', servers: [{ serverId: 'fixture/server0' }] });
            } finally { await f.host.dispose(); }
        });
    });
    it('retains a shared document until its last holder closes', async () => {
        await withTempDir('happier-lsp-shared-document-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'shared');
            const f = await fixture(rootPath);
            try {
                await f.open('a.ts', 'shared');
                await f.open('a.ts', 'shared');
                expect(f.protocolHandles).toHaveLength(1);
                await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'close', path: 'a.ts' } });
                expect(await f.query('hover', 'a.ts', { position: { line: 0, character: 0 } })).toMatchObject({ status: 'ok', sections: [{ markdown: 'shared' }] });
                expect(f.protocolHandles).toHaveLength(1);
                await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'close', path: 'a.ts' } });
                await expect(f.protocolHandles[0].wait()).resolves.toBeDefined();
            } finally { await f.host.dispose(); }
        });
    });
    it('settles an opening holder and terminates its child when close arrives during initialize', async () => {
        await withTempDir('happier-lsp-close-initialize-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'shared');
            const f = await fixture(rootPath, 1, { stallInitialize: true });
            try {
                const opening = f.open('a.ts', 'shared');
                await vi.waitFor(async () => expect((await f.messages()).some(message => message.method === 'initialize')).toBe(true));
                // The controller can subscribe before open acknowledges: the real
                // Machine watch already reports native startup during initialize.
                expect(DaemonLspWatchResponseSchema.parse(await f.call(RPC_METHODS.DAEMON_LSP_WATCH, { rootPath })))
                    .toMatchObject({ status: 'ok', servers: [{ state: 'starting', loading: false }] });
                expect(await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'close', path: 'a.ts' } })).toMatchObject({ status: 'ok' });
                await opening;
                expect(f.protocolHandles).toHaveLength(1);
                await expect(f.protocolHandles[0].wait()).resolves.toBeDefined();
            } finally { await f.host.dispose(); }
        });
    });
    it('does not start a child after its holder closes during asynchronous marker discovery', async () => {
        await withTempDir('happier-lsp-close-markers-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'shared');
            await writeFile(join(rootPath, 'project.marker'), '');
            const f = await fixture(rootPath, 1, {}, ['project.marker']);
            try {
                const opening = f.open('a.ts', 'shared');
                expect(await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'close', path: 'a.ts' } })).toMatchObject({ status: 'ok' });
                await opening;
                expect(f.protocolHandles).toHaveLength(0);
                const watch = DaemonLspWatchResponseSchema.parse(await f.call(RPC_METHODS.DAEMON_LSP_WATCH, { rootPath }));
                expect(watch).toMatchObject({ status: 'ok', servers: [] });
            } finally { await f.host.dispose(); }
        });
    });
    it('prevents late attachment after host disposal during asynchronous marker discovery', async () => {
        await withTempDir('happier-lsp-dispose-markers-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'shared');
            await writeFile(join(rootPath, 'project.marker'), '');
            const f = await fixture(rootPath, 1, {}, ['project.marker']);
            try {
                const opening = f.open('a.ts', 'shared');
                await f.host.dispose();
                await opening;
                expect(f.protocolHandles).toHaveLength(0);
            } finally { await f.host.dispose(); }
        });
    });
    it('keeps narrower marker sessions independent while accepting workspace external changes', async () => {
        await withTempDir('happier-lsp-marker-sessions-', async rootPath => {
            for (const directory of ['one', 'two']) {
                await mkdir(join(rootPath, directory));
                await writeFile(join(rootPath, directory, 'project.marker'), '');
                await writeFile(join(rootPath, directory, 'a.ts'), directory);
            }
            await writeFile(join(rootPath, 'unrelated.ts'), 'unrelated');
            const f = await fixture(rootPath, 1, {}, ['project.marker']);
            try {
                await f.open('one/a.ts', 'one');
                await f.open('two/a.ts', 'two');
                expect(f.protocolHandles).toHaveLength(2);
                for (const directory of ['one', 'two']) {
                    expect(await f.query('hover', `${directory}/a.ts`, { position: { line: 0, character: 0 } })).toMatchObject({ status: 'ok', sections: [{ markdown: directory }] });
                    expect(await f.query('references', `${directory}/a.ts`, { position: { line: 0, character: 0 } })).toMatchObject({ status: 'ok', locations: [{ path: `${directory}/a.ts`, lineText: directory }] });
                }
                expect(await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'external', paths: ['two/a.ts', 'unrelated.ts'] } })).toMatchObject({ status: 'ok' });
                await Promise.all(f.protocolHandles.map(handle => handle.client.request('fixture/barrier')));
                const changes = (await f.messages()).filter(message => message.method === 'workspace/didChangeWatchedFiles');
                expect(changes).toHaveLength(2);
                for (const change of changes) expect(change).toMatchObject({ params: { changes: [{ uri: expect.stringContaining('/two/a.ts') }, { uri: expect.stringContaining('/unrelated.ts') }] } });
                expect(f.protocolHandles).toHaveLength(2);
            } finally { await f.host.dispose(); }
        });
    });
    it.each(['snapshot', 'open'] as const)('restores every existing holder when a registry update adds a definition on %s', async operation => {
        await withTempDir('happier-lsp-registry-holders-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'shared');
            const f = await fixture(rootPath);
            try {
                await f.open('a.ts', 'shared');
                await f.open('a.ts', 'shared');
                f.setDefinitionCount(2);
                expect(await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: operation, path: 'a.ts', languageId: 'typescript', version: 2, text: 'shared', unsaved: false } })).toMatchObject({ status: 'ok' });
                expect(f.protocolHandles).toHaveLength(2);
                await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'close', path: 'a.ts' } });
                expect(await f.query('hover', 'a.ts', { serverId: 'fixture/server1', position: { line: 0, character: 0 } })).toMatchObject({ status: 'ok', sections: [{ serverId: 'fixture/server1', markdown: 'shared' }] });
                expect(f.protocolHandles).toHaveLength(2);
                if (operation === 'open') {
                    await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'close', path: 'a.ts' } });
                    expect(await f.query('hover', 'a.ts', { serverId: 'fixture/server1', position: { line: 0, character: 0 } })).toMatchObject({ status: 'ok' });
                    expect(f.protocolHandles).toHaveLength(2);
                }
                await f.call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath, op: { op: 'close', path: 'a.ts' } });
                await Promise.all(f.protocolHandles.map(handle => expect(handle.wait()).resolves.toBeDefined()));
            } finally { await f.host.dispose(); }
        });
    });
    it('preserves special property names as own watch dictionary paths', async () => {
        await withTempDir('happier-lsp-watch-keys-', async rootPath => {
            const f = await fixture(rootPath);
            try {
                for (const path of ['__proto__', 'constructor']) {
                    await writeFile(join(rootPath, path), 'broken');
                    await f.open(path, 'broken');
                    expect(await f.query('diagnostics', path)).toMatchObject({ status: 'ok', diagnostics: [{ path, message: 'broken' }] });
                }
                const rawWatch = await f.call(RPC_METHODS.DAEMON_LSP_WATCH, { rootPath });
                if (!rawWatch || typeof rawWatch !== 'object' || !('diagnostics' in rawWatch) || !rawWatch.diagnostics || typeof rawWatch.diagnostics !== 'object') throw new Error('Expected watch diagnostics dictionary');
                expect(Object.hasOwn(rawWatch.diagnostics, '__proto__')).toBe(true);
                const watch = DaemonLspWatchResponseSchema.parse(rawWatch);
                if (watch.status !== 'ok') throw new Error('Expected watch snapshot');
                expect(Object.keys(watch.diagnostics).sort()).toEqual(['__proto__', 'constructor']);
                for (const path of ['__proto__', 'constructor']) {
                    expect(Object.hasOwn(watch.diagnostics, path)).toBe(true);
                    expect(watch.diagnostics[path]).toMatchObject({ 'fixture/server0': { state: 'ready', items: [{ path, message: 'broken' }] } });
                }
            } finally { await f.host.dispose(); }
        });
    });
    it('pages a real native reference response larger than the Machine tunnel reply budget', async () => {
        await withTempDir('happier-lsp-large-references-', async rootPath => {
            const text = 'x\n'.repeat(3500);
            await writeFile(join(rootPath, 'a.ts'), text);
            const f = await fixture(rootPath, 1, { referenceCount: 3500 });
            try {
                await f.open('a.ts', text);
                const result = DaemonLspQueryResponseSchema.parse(await f.query('references', 'a.ts', { position: { line: 0, character: 0 } }));
                expect(result).toMatchObject({ status: 'ok', kind: 'references', hasMore: true });
                if (result.status !== 'ok' || result.kind !== 'references') throw new Error('Expected reference page');
                expect(result.locations.length).toBeGreaterThan(0);
                expect(result.locations.length).toBeLessThan(3500);
                expect(result.locations.every(location => location.lineText === 'x')).toBe(true);
                expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_RAW_PAYLOAD_BYTES);
            } finally { await f.host.dispose(); }
        });
    });
    it('keeps an exact-byte reference page intact and omits an item on one-byte overflow', () => {
        const result = { status: 'ok' as const, kind: 'references' as const, locations: [{ serverId: 'fixture/server', path: 'a.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, lineText: '' }], hasMore: false };
        result.locations[0].lineText = 'x'.repeat(DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_RAW_PAYLOAD_BYTES - Buffer.byteLength(JSON.stringify(result), 'utf8'));
        expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBe(DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_RAW_PAYLOAD_BYTES);
        expect(pageLanguageServerReferences(result)).toEqual(result);
        const overflow = { ...result, locations: [{ ...result.locations[0], lineText: `${result.locations[0].lineText}x` }] };
        const overflowPage = pageLanguageServerReferences(overflow);
        expect(overflowPage.hasMore).toBe(true);
        expect(overflowPage.locations).toHaveLength(0);
    });
    it('pages reference results at the existing transport byte boundary without a result-count cap', () => {
        const result = { status: 'ok' as const, kind: 'references' as const, locations: Array.from({ length: 3000 }, (_, line) => ({ serverId: 'fixture/server', path: 'a.ts', range: { start: { line, character: 0 }, end: { line, character: 1 } }, lineText: 'λ'.repeat(100) })), hasMore: false };
        const page = pageLanguageServerReferences(result);
        expect(page.hasMore).toBe(true);
        expect(page.locations.length).toBeGreaterThan(0);
        expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_RAW_PAYLOAD_BYTES);
        expect(Buffer.byteLength(JSON.stringify({ ...page, locations: result.locations.slice(0, page.locations.length + 1) }), 'utf8')).toBeGreaterThan(DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_RAW_PAYLOAD_BYTES);
    });
});
