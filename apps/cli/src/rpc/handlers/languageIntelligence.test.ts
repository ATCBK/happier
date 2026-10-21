import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, symlink, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import type { Machine } from '@/api/types';
import { ApiMachineClient } from '@/api/apiMachine';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { DaemonLspQueryResponseSchema, DaemonLspRestartResponseSchema, DaemonLspSyncResponseSchema, DaemonLspWatchResponseSchema } from '@happier-dev/protocol/machines/languageIntelligence';
import { registerSessionHandlers } from './registerSessionHandlers';
import { registerLanguageIntelligenceHandlers } from './languageIntelligence';
import { createLanguageServerHost } from '@/lsp/languageServerHost';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createTargetedActionRpcRequestV1 } from '@happier-dev/protocol/actions/actionRpcTransport';

describe('language intelligence registered Machine transport', () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  async function fixture() {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-lsp-rpc-'));
    roots.push(rootPath);
    const handlers = new Map<string, RpcHandler>();
    const registrar: RpcHandlerRegistrar = { registerHandler: (method, handler) => { handlers.set(method, handler); } };
    registerLanguageIntelligenceHandlers(registrar, rootPath, { accessPolicy: { kind: 'restrictedRoots', roots: [rootPath] } });
    const call = async (method: string, input: unknown, signal?: AbortSignal) => {
      const handler = handlers.get(method);
      expect(handler, `transport registration installs ${method}`).toBeDefined();
      if (!handler) throw new Error('Missing language intelligence handler');
      return handler(input, signal ? { signal } : undefined);
    };
    return { rootPath, call };
  }

  it('registers semantic mutations only through Action admission and rejects a foreign operation', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-lsp-edit-action-'));
    roots.push(rootPath);
    await writeFile(join(rootPath, 'a.ts'), 'old');
    const handlers = new Map<string, RpcHandler>();
    const registrar: RpcHandlerRegistrar = { registerHandler: (method, handler) => { handlers.set(method, handler); } };
    const host = createLanguageServerHost({ readCurrentContributionRegistry: () => null });
    const executor = createActionExecutor({ languageIntelligenceApply: ({ request }, context) => host.apply(request, { signal: context.signal }) });
    const request = { rootPath, path: 'a.ts', operation: { kind: 'rename', files: [{ path: 'a.ts',
      expectedHash: createHash('sha256').update('old').digest('hex'), edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, text: 'next' }],
    }] } };
    const context = { signal: new AbortController().signal, localActionContext: { surface: 'ui', authority: 'present_user' } } as const;
    try {
      registerLanguageIntelligenceHandlers(registrar, rootPath, { machineId: 'machine' });
      expect(await handlers.get(RPC_METHODS.DAEMON_LSP_RENAME_APPLY)!(request, context)).toMatchObject({ ok: false });
      expect(await readFile(join(rootPath, 'a.ts'), 'utf8')).toBe('old');
      registerLanguageIntelligenceHandlers(registrar, rootPath, { machineId: 'machine', host, resolveActionExecutor: () => executor });
      expect(await handlers.get(RPC_METHODS.DAEMON_LSP_FILE_RENAME_APPLY)!(request, context)).toMatchObject({ ok: false, errorCode: 'invalid_action_transport_input' });
      expect(await handlers.get(RPC_METHODS.DAEMON_LSP_RENAME_APPLY)!(createTargetedActionRpcRequestV1(request, { kind: 'machine', machineId: 'machine' }), context))
        .toMatchObject({ ok: true, results: [{ status: 'replaced' }] });
      expect(await readFile(join(rootPath, 'a.ts'), 'utf8')).toBe('next');
    } finally { await host.dispose(); }
  });

  it('exposes typed no-server behavior through the transport and real process host', async () => {
    const { rootPath, call } = await fixture();
    const opened = await call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath,
      op: { op: 'open', path: 'file.p7-no-server', languageId: 'p7-no-server', version: 0, text: '', unsaved: false } });
    expect(DaemonLspSyncResponseSchema.parse(opened)).toEqual({ status: 'unavailable', reason: 'no_capable_server' });
    expect(DaemonLspQueryResponseSchema.parse(await call(RPC_METHODS.DAEMON_LSP_QUERY, {
      rootPath, path: 'file.p7-no-server', kind: 'hover', position: { line: 0, character: 0 },
    }))).toMatchObject({ status: 'unavailable' });
    expect(DaemonLspRestartResponseSchema.parse(await call(RPC_METHODS.DAEMON_LSP_RESTART, { rootPath }))).toMatchObject({ status: 'unavailable' });
    expect(DaemonLspWatchResponseSchema.parse(await call(RPC_METHODS.DAEMON_LSP_WATCH, { rootPath })))
      .toEqual({ status: 'ok', revision: 0, servers: [], diagnostics: {} });
  });

  it('serves LSP on the Machine ingress but never installs it on a foreground Session', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-lsp-machine-rpc-'));
    roots.push(rootPath);
    const previousWorkingDirectory = process.env.HAPPIER_MACHINE_RPC_WORKING_DIRECTORY;
    const machine: Machine = {
      id: 'machine-lsp-test', encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'legacy',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
    };
    const session = new RpcHandlerManager({ scopePrefix: 'session-lsp-test', encryptionMode: 'plain' });
    const registration = registerSessionHandlers(session, rootPath, { sessionId: 'session-lsp-test' });
    let client: ApiMachineClient | undefined;
    try {
      process.env.HAPPIER_MACHINE_RPC_WORKING_DIRECTORY = rootPath;
      client = new ApiMachineClient('test-token', machine);
      const requests = [
        [RPC_METHODS.DAEMON_LSP_SYNC, { rootPath,
          op: { op: 'open', path: 'file.p7-no-server', languageId: 'p7-no-server', version: 0, text: '', unsaved: false } }],
        [RPC_METHODS.DAEMON_LSP_QUERY, { rootPath, path: 'file.p7-no-server', kind: 'documentSymbols' }],
        [RPC_METHODS.DAEMON_LSP_WATCH, { rootPath }],
        [RPC_METHODS.DAEMON_LSP_RESTART, { rootPath }],
      ] as const;
      const rpc = { invokeLocal: client.invokeLocalMachineAction.bind(client) };
      expect(DaemonLspSyncResponseSchema.parse(await rpc.invokeLocal(...requests[0])))
        .toEqual({ status: 'unavailable', reason: 'no_capable_server' });
      expect(DaemonLspQueryResponseSchema.parse(await rpc.invokeLocal(...requests[1])))
        .toMatchObject({ status: 'unavailable' });
      expect(DaemonLspWatchResponseSchema.parse(await rpc.invokeLocal(...requests[2])))
        .toEqual({ status: 'ok', revision: 0, servers: [], diagnostics: {} });
      expect(DaemonLspRestartResponseSchema.parse(await rpc.invokeLocal(...requests[3])))
        .toEqual({ status: 'unavailable', reason: 'session_unavailable' });
      for (const [method, request] of requests) {
        expect(await session.invokeLocal(method, request)).toMatchObject({ errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
      }
    } finally {
      await client?.shutdown();
      await registration.dispose();
      if (previousWorkingDirectory === undefined) delete process.env.HAPPIER_MACHINE_RPC_WORKING_DIRECTORY;
      else process.env.HAPPIER_MACHINE_RPC_WORKING_DIRECTORY = previousWorkingDirectory;
    }
  });

  it('rejects unknown process fields, traversals, and roots outside the filesystem authority', async () => {
    const { rootPath, call } = await fixture();
    const query = { rootPath, path: 'a.ts', kind: 'documentSymbols' };
    expect(await call(RPC_METHODS.DAEMON_LSP_QUERY, { ...query, executable: '/tmp/evil' })).toEqual({ status: 'error', errorCode: 'invalid_request' });
    expect(await call(RPC_METHODS.DAEMON_LSP_QUERY, { ...query, path: '../secret' })).toEqual({ status: 'error', errorCode: 'invalid_request' });
    expect(await call(RPC_METHODS.DAEMON_LSP_QUERY, { ...query, rootPath: join(rootPath, '..') })).toEqual({ status: 'error', errorCode: 'path_not_allowed' });
    const controller = new AbortController();
    controller.abort();
    expect(await call(RPC_METHODS.DAEMON_LSP_QUERY, query, controller.signal)).toEqual({ status: 'error', errorCode: 'cancelled' });
  });

  it.skipIf(process.platform === 'win32')('refuses a workspace-relative document whose symlink leaves the selected root', async () => {
    const { rootPath, call } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'happier-lsp-outside-'));
    roots.push(outside);
    await symlink(outside, join(rootPath, 'link'));
    expect(await call(RPC_METHODS.DAEMON_LSP_QUERY, { rootPath, path: 'link/secret.ts', kind: 'documentSymbols' }))
      .toEqual({ status: 'error', errorCode: 'path_not_allowed' });
  });
});
