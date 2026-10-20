import { describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServerSession } from './serverSession';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { withTempDir } from '@/testkit/fs/tempDir';
import type { LanguageServerDefinition } from './languageServerDefinitions';
import type { PluginProtocolClientHandle } from '@happier-dev/plugin-sdk/exec/protocol-clients';
import { DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_RAW_PAYLOAD_BYTES } from '@happier-dev/protocol/features/payload/capabilities/machineTunnelCapabilities';
const definition: LanguageServerDefinition = {
    id: 'fixture/languageServers/typescript', pluginId: 'fixture', manifestPath: '/fixture/plugin.json', title: 'Fixture',
    executable: { kind: 'systemTool', id: 'server' }, args: [], languageIds: { typescript: 'typescript', tsx: 'typescriptreact' },
    initializationOptions: { userPreferences: { tsserver: { automaticTypeAcquisition: { enabled: false } } }, disablePushDiagnostics: true },
};
async function fixture(rootPath: string, options: Record<string, unknown> = {}) {
    const log = join(rootPath, 'messages.jsonl');
    await writeFile(log, '');
    const protocols: PluginProtocolClientHandle<'jsonRpc'>[] = [];
    const session = createServerSession({ definition, rootPath, workspaceRoot: rootPath, onChange: () => undefined,
        async openProtocol(input) {
            const service = createStablePluginExecService({ allowedExecutables: [definition.executable], signal: input.signal,
                processOwner: input.processOwner, isOccurrenceCurrent: () => !input.signal.aborted,
                resolveExecutable: async () => ({ command: process.execPath, args: [resolve('src/lsp/__fixtures__/languageServer.cjs'), log, JSON.stringify(options)] }),
                resolvePath: async () => rootPath,
            });
            const protocol = await service.clients.spawn({ kind: 'jsonRpc', framing: 'contentLength', maxFrameBytes: DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_RAW_PAYLOAD_BYTES, launch: { executable: definition.executable, cwd: rootPath } });
            protocols.push(protocol);
            return protocol;
        } });
    const messages = async () => String(await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
    return { session, protocols, messages };
}
describe('language server session', () => {
    it('starts on query, answers registration before serving, and opts diagnostics in only on Check problems', async () => {
        await withTempDir('happier-lsp-session-', async (root) => {
            const { session, protocols, messages } = await fixture(root);
            try {
                await session.open({ path: 'a.ts', languageId: 'typescript', text: 'broken', version: 1, unsaved: false });
                expect(protocols).toHaveLength(0);
                const result = await session.query({ path: 'a.ts', kind: 'hover', position: { line: 0, character: 0 } });
                expect(result.value).toMatchObject({ contents: { value: 'broken' } });
                expect((await messages()).some(m => m.id === 'registration' && !m.method)).toBe(true);
                expect((await messages()).filter(m => m.method === 'textDocument/diagnostic')).toHaveLength(0);
                await session.query({ path: 'a.ts', kind: 'diagnostics' });
                expect(session.diagnostics.get('a.ts')).toMatchObject({ state: 'ready', version: 1, items: [{ message: 'broken' }] });
                expect(protocols).toHaveLength(1);
            }
            finally {
                await session.dispose();
            }
            expect((await messages()).find(m => m.method === 'shutdown')).not.toHaveProperty('params');
        });
    });
    it('keeps failed initialization sticky until explicit restart and releases the child on last close', async () => {
        await withTempDir('happier-lsp-sticky-', async (root) => {
            const { session, protocols } = await fixture(root, { failInitialize: true });
            try {
                await session.open({ path: 'a.ts', languageId: 'typescript', text: 'a', version: 1, unsaved: false });
                await expect(session.query({ path: 'a.ts', kind: 'hover', position: { line: 0, character: 0 } })).rejects.toMatchObject({ code: 'session_unavailable' });
                await expect(session.query({ path: 'a.ts', kind: 'hover', position: { line: 0, character: 0 } })).rejects.toMatchObject({ code: 'session_unavailable' });
                expect(protocols).toHaveLength(1);
                expect(session.status()).toMatchObject({ state: 'unavailable', reason: 'start_failed' });
                await session.restart();
                expect(protocols).toHaveLength(2);
                await session.close('a.ts');
                await expect(protocols[1].wait()).resolves.toBeDefined();
                expect(session.status().state).toBe('stopped');
            }
            finally {
                await session.dispose();
            }
        });
    });
    it.each([0, 1, 2])('honors sync kind %s while keeping the document version', async (syncKind) => {
        await withTempDir('happier-lsp-sync-', async (root) => {
            const { session, messages } = await fixture(root, { syncKind });
            try {
                await session.open({ path: 'a.ts', languageId: 'typescript', text: 'one', version: 1, unsaved: false });
                await session.query({ path: 'a.ts', kind: 'hover', position: { line: 0, character: 0 } });
                await session.change({ path: 'a.ts', version: 2, baseVersion: 1, edit: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 3, text: 'two' }, unsaved: true });
                const changes = (await messages()).filter(m => m.method === 'textDocument/didChange');
                if (syncKind === 0)
                    expect(changes).toHaveLength(0);
                else
                    expect(changes.at(-1)).toMatchObject({ params: { textDocument: { version: 2 }, contentChanges: [syncKind === 1 ? { text: 'two' } : { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, text: 'two' }] } });
            }
            finally {
                await session.dispose();
            }
        });
    });
});
