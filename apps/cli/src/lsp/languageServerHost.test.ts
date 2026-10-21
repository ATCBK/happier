import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { DaemonLspQueryResponseSchema, DaemonLspSyncResponseSchema, DaemonLspWatchResponseSchema } from '@happier-dev/protocol/machines/languageIntelligence';
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
async function fixture(rootPath: string, count = 1, behavior: Record<string, unknown> = {}, rootMarkers?: readonly string[], readPolicy?: MachineResourcesPolicyReader) {
    const protocolHandles: PluginProtocolClientHandle<'jsonRpc'>[] = [];
    const log = join(rootPath, 'messages.jsonl');
    await writeFile(log, '');
    const registryFor = (definitionCount: number) => createResolvedContributionRegistry({ languageServers: Array.from({ length: definitionCount }, (_, index) => ({
            provenance: 'external' as const, source: { kind: 'path' as const }, pluginId: 'fixture', identity: { pluginId: 'fixture', localId: `server${index}` }, manifestPath: join(rootPath, 'plugin.json'),
            definition: { id: `server${index}`, title: `Fixture ${index}`, languageIds: { typescript: 'typescript', tsx: 'typescriptreact' }, filePatterns: ['**/*.ts', '**/*.tsx'], ...(rootMarkers ? { rootMarkers: [...rootMarkers] } : {}), executable: { kind: 'systemTool' as const, id: 'server' }, args: [], initializationOptions: { disablePushDiagnostics: true } },
        })) });
    let registry = registryFor(count);
    const host = createLanguageServerHost({ readCurrentContributionRegistry: () => registry, readPolicy, async openProtocol(input) {
            // The OS executable/protocol child is the system boundary; host, catalog, codec and supervisor stay real.
            const service = createStablePluginExecService({ allowedExecutables: [input.definition.executable], signal: input.signal, processOwner: input.processOwner, isOccurrenceCurrent: () => !input.signal.aborted,
                resolveExecutable: async () => ({ command: process.execPath, args: [resolve('src/lsp/__fixtures__/languageServer.cjs'), log, JSON.stringify(behavior)] }), resolvePath: async () => rootPath });
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
    return { host, open, query, call, protocolHandles, setDefinitionCount: (definitionCount: number) => { registry = registryFor(definitionCount); }, messages: async () => String(await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>) };
}
describe('language intelligence composed host', () => {
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
                await f.protocolHandles[0].client.notify('fixture/release', { method: 'textDocument/hover' });
                expect(await second).toMatchObject({ status: 'ok', sections: [{ markdown: 'shared' }] });
                await expect(f.protocolHandles[0].wait()).resolves.toBeDefined();
                expect(f.protocolHandles).toHaveLength(1);
            } finally { await f.host.dispose(); }
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
