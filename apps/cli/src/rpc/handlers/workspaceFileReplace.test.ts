import { createHash } from 'node:crypto';
import * as filesystem from 'node:fs/promises';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { callSocketRpc } from '@happier-dev/sync-client';
import { buildWorkspaceFileRestoreOperation } from '@happier-dev/protocol/machines/workspaceFilesReplace';
import { DaemonWorkspaceFileReplacePreviewResponseSchema, DaemonWorkspaceFileReplaceApplyResponseSchema, WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES } from '@happier-dev/protocol/machines/workspaceFiles';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandler } from '@/api/rpc/types';
import type { RpcActionExecutor } from './_actionDispatchAdapter';
import { applyWorkspaceFileReplace, previewWorkspaceFileReplace, registerWorkspaceFileReplaceHandlers } from './workspaceFileReplace';
import { registerSessionHandlers } from './registerSessionHandlers';
import { ApiMachineClient } from '@/api/apiMachine';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';

// Keep the filesystem real while exposing its write boundary as a configurable spy.
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
describe('registered workspace replace transport', () => {
  let root: string;
  let handlers: Map<string, RpcHandler>;
  let dispose: (() => Promise<void>) | undefined;
  const matcher = { query: 'old', replacement: 'new', matchCase: true, regex: false };
  beforeEach(async () => {
    vi.mocked(filesystem.writeFile).mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).writeFile);
    root = await mkdtemp(join(tmpdir(), 'happier-replace-'));
    handlers = new Map();
    dispose = undefined;
    registerWorkspaceFileReplaceHandlers({ registerHandler: (id, handler) => { handlers.set(id, handler); } }, root, {
      machineId: 'machine', actionExecutor: createActionExecutor({
        workspaceFilesReplacePreview: ({ machineId: _machineId, ...request }, context) =>
          previewWorkspaceFileReplace(request, root, { kind: 'osUser' }, context.signal ? { signal: context.signal } : undefined),
      }),
    });
  });
  afterEach(async () => {
    vi.mocked(filesystem.writeFile).mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).writeFile);
    vi.restoreAllMocks(); await dispose?.(); await rm(root, { recursive: true, force: true });
  });
  const preview = async (extra = {}) => DaemonWorkspaceFileReplacePreviewResponseSchema.parse(await handlers.get(RPC_METHODS.DAEMON_WORKSPACE_FILES_REPLACE_PREVIEW)!({ rootPath: root, ...matcher, ...extra }));
  const apply = async (operation: unknown, signal?: AbortSignal) => DaemonWorkspaceFileReplaceApplyResponseSchema.parse(await applyWorkspaceFileReplace({ rootPath: root, operation }, root, { kind: 'osUser' }, signal ? { signal } : undefined));

  it('refuses preview and replacement at production registration without an Action admission owner', async () => {
    handlers.clear();
    dispose = registerSessionHandlers({ registerHandler: (id, handler) => { handlers.set(id, handler); } }, root).dispose;
    await writeFile(join(root, 'a.txt'), 'old');
    expect(await handlers.get(RPC_METHODS.DAEMON_WORKSPACE_FILES_REPLACE_PREVIEW)!({ rootPath: root, ...matcher }))
      .toMatchObject({ ok: false });
    expect(await handlers.get(RPC_METHODS.DAEMON_WORKSPACE_FILES_REPLACE_APPLY)!({ rootPath: root,
      operation: { kind: 'replace', matcher, files: [{ path: 'a.txt', expectedHash: hash(Buffer.from('old')) }] },
    })).toMatchObject({ ok: false });
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('old');
  });

  it.each(['ui', 'rpc'] as const)('honors the configured %s Ask override before registered preview reads files', async surface => {
    await writeFile(join(root, 'a.txt'), 'old');
    const requests: unknown[] = [];
    const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
      'workspace.files.replace.preview': { approvalRequiredSurfaces: [surface] },
    } });
    const executor = createActionExecutor({
      // The physical implementation is real; an approval refusal must prevent reaching it.
      workspaceFilesReplacePreview: ({ machineId: _machineId, ...request }, context) =>
        previewWorkspaceFileReplace(request, root, { kind: 'osUser' }, context.signal ? { signal: context.signal } : undefined),
      approvalsCreate: async ({ request }) => { requests.push(request); return { artifactId: 'preview-approval' }; },
      approvalsUpdate: async () => ({ ok: true }),
      approvalsWaitForDecision: async ({ request }) => ({ decision: 'reject', request }),
      isActionApprovalRequired: (id, context, input) => isApprovalRequiredByActionsSettings(id, settings, context, undefined, undefined, input),
    });
    // As in production, the receiving credential factory binds the Home; Action input does not.
    const receivingExecutor: RpcActionExecutor = {
      execute: (id, input, context) => executor.execute(id, input, { ...context, serverId: 'home' }),
    };
    handlers.clear();
    dispose = registerSessionHandlers({ registerHandler: (id, handler) => { handlers.set(id, handler); } }, root, {
      workspaceFileReplaceActionExecutor: receivingExecutor, workspaceFileReplaceMachineId: 'machine',
    }).dispose;
    const outcome = await handlers.get(RPC_METHODS.DAEMON_WORKSPACE_FILES_REPLACE_PREVIEW)!({ rootPath: root, ...matcher }, {
      signal: new AbortController().signal,
      machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: 'machine',
        installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => true,
      localActionContext: { surface, authority: surface === 'ui' ? 'present_user' : 'account_automation', actionRequestId: 'preview-request' },
    });
    expect(outcome).toMatchObject(surface === 'ui'
      ? { kind: 'approval_request_created', actionId: 'workspace.files.replace.preview', artifactId: 'preview-approval' }
      : { ok: false, errorCode: 'approval_rejected' });
    expect(requests).toEqual([expect.objectContaining({ actionId: 'workspace.files.replace.preview',
      actionArgs: { machineId: 'machine', rootPath: root, ...matcher } })]);
  });

  it('previews raw BOM hashes then applies only selected matches and restores exact bytes through Actions', async () => {
    // Use the production composition for this seam test. Clearing the direct
    // owner registration makes removal/misbinding in registerSessionHandlers fail.
    handlers.clear();
    const executor = createActionExecutor({
      workspaceFilesReplacePreview: ({ machineId: _machineId, ...request }, context) =>
        previewWorkspaceFileReplace(request, root, { kind: 'osUser' }, context.signal ? { signal: context.signal } : undefined),
      workspaceFilesReplace: async ({ machineId: _machineId, ...request }, context) =>
        applyWorkspaceFileReplace(request, root, { kind: 'osUser' }, context.signal ? { signal: context.signal } : undefined),
    });
    dispose = registerSessionHandlers({ registerHandler: (id, handler) => { handlers.set(id, handler); } }, root, {
      workspaceFileReplaceActionExecutor: executor, workspaceFileReplaceMachineId: 'machine',
    }).dispose;
    const bytes = Buffer.from('\uFEFFold old\r\n');
    await writeFile(join(root, 'a.txt'), bytes);
    const page = await preview();
    expect(page).toMatchObject({ ok: true, files: [{ path: 'a.txt', hash: hash(bytes), matchCount: 2 }] });
    if (!page.ok) return;
    const context = { signal: new AbortController().signal, localActionContext: { surface: 'ui', authority: 'present_user' } } as const;
    const outcome = await handlers.get(RPC_METHODS.DAEMON_WORKSPACE_FILES_REPLACE_APPLY)!({ machineId: 'machine', rootPath: root,
      operation: { kind: 'replace', matcher,
        files: [{ path: 'a.txt', expectedHash: page.files[0].hash, excludedMatches: [{ line: page.files[0].matches[1].line, column16: page.files[0].matches[1].column16 }] }] },
    }, context);
    expect(outcome).toMatchObject({ ok: true, results: [{ status: 'replaced', matchCount: 1 }] });
    expect(await readFile(join(root, 'a.txt'))).toEqual(Buffer.from('\uFEFFnew old\r\n'));
    const result = DaemonWorkspaceFileReplaceApplyResponseSchema.parse(outcome);
    if (!result.ok) return;
    const restored = await handlers.get(RPC_METHODS.DAEMON_WORKSPACE_FILES_REPLACE_APPLY)!({ machineId: 'machine', rootPath: root,
      operation: { kind: 'restore', files: [{ path: 'a.txt', expectedHash: result.results[0].hash, edits: result.results[0].edits }] },
    }, context);
    expect(restored).toMatchObject({ results: [{ status: 'restored' }] });
    expect(await readFile(join(root, 'a.txt'))).toEqual(bytes);
  });

  it.each(['replace', 'restore'] as const)('keeps %s behind agent approval at the Action boundary', async kind => {
    await writeFile(join(root, 'a.txt'), kind === 'replace' ? 'old' : 'new');
    const requests: unknown[] = [];
    const executor = createActionExecutor({
      workspaceFilesReplace: async ({ machineId: _machineId, ...request }, context) =>
        applyWorkspaceFileReplace(request, root, { kind: 'osUser' }, context.signal ? { signal: context.signal } : undefined),
      // Approval Artifact persistence is the boundary; policy and dispatch stay real.
      approvalsCreate: async ({ request }) => { requests.push(request); return { artifactId: 'replace-approval' }; },
      approvalsUpdate: async () => ({ ok: true }),
      approvalsWaitForDecision: async ({ request }) => ({ decision: 'reject', request }),
      isActionApprovalRequired: (id, context, input) => isApprovalRequiredByActionsSettings(id,
        context.actionsSettings ?? ActionsSettingsV1Schema.parse({ v: 1 }), context, undefined, undefined, input),
    });
    const operation = kind === 'replace'
      ? { kind, matcher, files: [{ path: 'a.txt', expectedHash: hash(Buffer.from('old')) }] }
      : { kind, files: [{ path: 'a.txt', expectedHash: hash(Buffer.from('new')),
        edits: [{ startUtf16: 0, deleteLength: 3, insertText: 'new', originalText: 'old' }] }] };
    const input = { machineId: 'machine', rootPath: root, operation };
    expect(await executor.execute('workspace.files.replace', input, {
      surface: 'agent', authority: 'account_automation', actionRequestId: 'replace-request',
      serverId: 'home', runtimeAccountId: 'account', externalActionTarget: { kind: 'machine', machineId: 'machine' },
    })).toMatchObject({ ok: false, errorCode: 'approval_rejected' });
    expect(requests).toEqual([expect.objectContaining({ actionId: 'workspace.files.replace', actionArgs: input })]);
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe(kind === 'replace' ? 'old' : 'new');
  });

  it('refuses stale, deleted, root-escaping and symlink-escaping files without writing', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'happier-replace-outside-'));
    try {
      await writeFile(join(root, 'a.txt'), 'agent changed');
      await writeFile(join(outside, 'secret.txt'), 'old');
      await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
      const results = await apply({ kind: 'replace', matcher, files: [
        { path: 'a.txt', expectedHash: hash(Buffer.from('old')) },
        { path: 'missing.txt', expectedHash: hash(Buffer.from('old')) },
        { path: join(outside, 'secret.txt'), expectedHash: hash(Buffer.from('old')) },
        { path: 'link.txt', expectedHash: hash(Buffer.from('old')) },
      ] });
      expect(results).toMatchObject({ results: [{ status: 'changed' }, { status: 'changed' }, { status: 'failed' }, { status: 'failed' }] });
      expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('old');
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('agent changed');
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it('retains the native accepted operation and partial cancellation inverse until the terminal acknowledgement', async () => {
    const bytes = Buffer.from('\uFEFFold\r\n');
    for (const path of ['a.txt', 'b.txt']) await writeFile(join(root, path), bytes);
    const previousWorkingDirectory = process.env.HAPPIER_MACHINE_RPC_WORKING_DIRECTORY;
    process.env.HAPPIER_MACHINE_RPC_WORKING_DIRECTORY = root;
    const client = new ApiMachineClient('token', { id: 'machine', encryptionKey: new Uint8Array(32).fill(7),
      encryptionVariant: 'legacy', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    const runtime = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'account',
      generateOperationId: () => 'replace-operation' });
    const executor = createActionExecutor({ workspaceFilesReplace: client.createWorkspaceFileReplaceActionExecutor('home'),
      workspaceFilesReplacePreview: client.createWorkspaceFileReplacePreviewActionExecutor('home'),
      runActionOperation: runtime.runActionOperation });
    client.setRPCHandlers({ spawnSession: async () => ({ type: 'error', errorCode: 'SPAWN_FAILED', errorMessage: 'unused' }),
      stopSession: async () => true, requestShutdown: () => {} }, { externalActionIngressOwner: {
      currentServerId: 'home', executor, resolveTarget: async () => ({ kind: 'machine', machineId: 'machine' }),
    } });
    const { writeFile: write } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let cancellation: unknown;
    // The real OS write boundary pauses the first staged file. The real
    // operation owner cancels between files and retains the resulting inverse.
    vi.mocked(filesystem.writeFile).mockImplementation(async (path, data, options) => {
      await write(path, data, options);
      // ApiMachine also publishes metadata outside this workspace; only a staged file write is the cancellation boundary.
      if (!cancellation && typeof path === 'string' && dirname(path) === root)
        cancellation = await runtime.handlers.cancel({ operationId: 'replace-operation' });
    });
    try {
      expect(await executor.execute('workspace.files.replace.preview', { machineId: 'machine', rootPath: root, ...matcher },
        { surface: 'ui', authority: 'present_user', serverId: 'home', runtimeAccountId: 'account',
          externalActionTarget: { kind: 'machine', machineId: 'machine' } })).toMatchObject({ ok: true, result: {
            ok: true, files: [{ path: 'a.txt', hash: hash(bytes) }, { path: 'b.txt', hash: hash(bytes) }],
          } });
      const accepted = await executor.execute('workspace.files.replace', { machineId: 'machine', rootPath: root,
        operation: { kind: 'replace', matcher, files: ['a.txt', 'b.txt'].map(path => ({ path, expectedHash: hash(bytes) })) },
      }, { surface: 'ui', authority: 'present_user', serverId: 'home', runtimeAccountId: 'account',
        actionRequestId: 'replace-request', externalActionTarget: { kind: 'machine', machineId: 'machine' } });
      expect(accepted).toEqual({ ok: true, result: { operation: { operationId: 'replace-operation' } } });
      const terminal = await runtime.handlers.getV2({ operationId: 'replace-operation', waitForTerminal: true });
      expect(cancellation).toEqual({ kind: 'requested' });
      expect(terminal).toMatchObject({ kind: 'found', operation: { state: 'succeeded', result: {
        ok: true, results: [{ path: 'a.txt', status: 'replaced' }], cancelled: ['b.txt'],
      } } });
      if (terminal.kind !== 'found') return;
      const result = DaemonWorkspaceFileReplaceApplyResponseSchema.parse(terminal.operation.result);
      if (!result.ok) return;
      expect(await readFile(join(root, 'a.txt'))).toEqual(Buffer.from('\uFEFFnew\r\n'));
      expect(await readFile(join(root, 'b.txt'))).toEqual(bytes);
      vi.mocked(filesystem.writeFile).mockImplementation(write);
      expect(await apply({ kind: 'restore', files: result.results.map(file => ({ path: file.path,
        expectedHash: file.hash, edits: file.edits })) })).toMatchObject({ results: [{ status: 'restored' }] });
      expect(await readFile(join(root, 'a.txt'))).toEqual(bytes);
    } finally {
      await client.shutdown();
      if (previousWorkingDirectory == null) delete process.env.HAPPIER_MACHINE_RPC_WORKING_DIRECTORY;
      else process.env.HAPPIER_MACHINE_RPC_WORKING_DIRECTORY = previousWorkingDirectory;
    }
  });

  it('restores only when the post-hash and inserted-text assertions both hold', async () => {
    await writeFile(join(root, 'a.txt'), 'new');
    const edit = { startUtf16: 0, deleteLength: 3, insertText: 'wrong', originalText: 'old' };
    expect(await apply({ kind: 'restore', files: [{ path: 'a.txt', expectedHash: hash(Buffer.from('new')), edits: [edit] }] }))
      .toMatchObject({ results: [{ status: 'changed' }] });
    expect(await apply({ kind: 'restore', files: [{ path: 'a.txt', expectedHash: hash(Buffer.from('old')), edits: [{ ...edit, insertText: 'new' }] }] }))
      .toMatchObject({ results: [{ status: 'changed' }] });
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('new');
  });

  it('applies one semantic edit set through the guarded writer and restores exact multiline bytes', async () => {
    const apply = (operation: unknown) => applyWorkspaceFileReplace({ rootPath: root, operation }, root, { kind: 'osUser' });
    const bytes = Buffer.from('\uFEFFconst old = 1;\r\nold();\r\n');
    await writeFile(join(root, 'a.ts'), bytes);
    await writeFile(join(root, 'b.ts'), 'old\n');
    const result = await apply({ kind: 'editSet', files: [
      { path: 'a.ts', expectedHash: hash(bytes), edits: [
        { range: { start: { line: 0, character: 7 }, end: { line: 0, character: 10 } }, text: 'renamed' },
        { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }, text: 'renamed' },
      ] },
      { path: 'b.ts', expectedHash: hash(Buffer.from('old\n')), edits: [
        { range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } }, text: 'renamed\n// done\n' },
      ] },
    ] });
    expect(result).toMatchObject({ ok: true, results: [{ status: 'replaced' }, { status: 'replaced' }] });
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('\uFEFFconst renamed = 1;\r\nrenamed();\r\n');
    if (!result.ok) return;
    expect(await apply({ kind: 'restore', files: result.results.map(file => ({ path: file.path, expectedHash: file.hash, edits: file.edits })) }))
      .toMatchObject({ results: [{ status: 'restored' }, { status: 'restored' }] });
    expect(await readFile(join(root, 'a.ts'))).toEqual(bytes);
    expect(await readFile(join(root, 'b.ts'), 'utf8')).toBe('old\n');
  });

  it('rejects overlapping semantic edits and stale edit sets without writing', async () => {
    const apply = (operation: unknown) => applyWorkspaceFileReplace({ rootPath: root, operation }, root, { kind: 'osUser' });
    await writeFile(join(root, 'a.ts'), 'old();\n');
    const edit = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, text: 'new' };
    expect(await apply({ kind: 'editSet', files: [{ path: 'a.ts', expectedHash: hash(Buffer.from('old();\n')), edits: [edit, edit] }] }))
      .toMatchObject({ results: [{ status: 'failed', reason: 'overlapping_edits' }] });
    expect(await apply({ kind: 'editSet', files: [{ path: 'a.ts', expectedHash: hash(Buffer.from('older')), edits: [edit] }] }))
      .toMatchObject({ results: [{ status: 'changed' }] });
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('old();\n');
  });

  it('renames a semantic source with importer edits and guarded inverse rename without overwriting a destination', async () => {
    const apply = (operation: unknown) => applyWorkspaceFileReplace({ rootPath: root, operation }, root, { kind: 'osUser' });
    await writeFile(join(root, 'a.ts'), 'export const value = 1;\n');
    await writeFile(join(root, 'b.ts'), "import './a';\n");
    const originalHash = hash(Buffer.from('export const value = 1;\n'));
    const source = { path: 'a.ts', expectedHash: originalHash, edits: [], renameTo: 'renamed.ts' };
    const result = await apply({ kind: 'editSet', files: [source, { path: 'b.ts', expectedHash: hash(Buffer.from("import './a';\n")), edits: [
      { range: { start: { line: 0, character: 10 }, end: { line: 0, character: 11 } }, text: 'renamed' },
    ] }] });
    expect(result).toMatchObject({ results: [{ status: 'replaced', renameTo: 'renamed.ts' }, { status: 'replaced' }] });
    await expect(readFile(join(root, 'a.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(root, 'b.ts'), 'utf8')).toBe("import './renamed';\n");
    if (!result.ok) return;
    expect(await apply({ kind: 'restore', files: result.results.map(file => ({
      path: file.renameTo ?? file.path, expectedHash: file.hash, edits: file.edits,
      ...(file.renameTo ? { renameTo: file.path } : {}),
    })) })).toMatchObject({ results: [{ status: 'restored' }, { status: 'restored' }] });
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('export const value = 1;\n');
    await writeFile(join(root, 'renamed.ts'), 'user destination');
    expect(await apply({ kind: 'editSet', files: [source, { path: 'b.ts', expectedHash: hash(Buffer.from("import './a';\n")), edits: [
      { range: { start: { line: 0, character: 10 }, end: { line: 0, character: 11 } }, text: 'renamed' },
    ] }] })).toMatchObject({ results: [{ status: 'changed', reason: 'expected_file_absent' }, { status: 'skipped', reason: 'edit_set_aborted' }] });
    expect(await readFile(join(root, 'renamed.ts'), 'utf8')).toBe('user destination');
    expect(await readFile(join(root, 'b.ts'), 'utf8')).toBe("import './a';\n");
  });

  it('maps an agent write during staging to changed through the real guarded writer', async () => {
    const dest = join(root, 'a.txt');
    await writeFile(dest, 'old');
    const { writeFile: write } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    // The filesystem is the boundary. The actual guarded writer and final
    // before-rename hash check both remain real.
    vi.mocked(filesystem.writeFile).mockImplementation(async (path, data, options) => {
      await write(path, data, options);
      if (path !== dest) await write(dest, 'agent changed');
    });
    const result = await apply({ kind: 'replace', matcher, files: [{ path: 'a.txt', expectedHash: hash(Buffer.from('old')) }] });
    expect(result).toMatchObject({ results: [{ status: 'changed', reason: 'hash_mismatch' }] });
    expect(await readFile(dest, 'utf8')).toBe('agent changed');
  });

  it('keeps importer Undo unattempted when the inverse file move conflicts', async () => {
    const current = "import './renamed';\n";
    await writeFile(join(root, 'a.ts'), 'new user file');
    await writeFile(join(root, 'renamed.ts'), 'export const value = 1;\n');
    await writeFile(join(root, 'b.ts'), current);
    const operation = buildWorkspaceFileRestoreOperation([
      { path: 'a.ts', status: 'replaced', hash: hash(Buffer.from('export const value = 1;\n')), edits: [], renameTo: 'renamed.ts' },
      { path: 'b.ts', status: 'replaced', hash: hash(Buffer.from(current)), edits: [{ startUtf16: 10, deleteLength: 1, insertText: 'renamed', originalText: 'a' }] },
    ]);
    const result = await applyWorkspaceFileReplace({ rootPath: root, operation }, root, { kind: 'osUser' });
    expect(result).toMatchObject({ results: [{ status: 'skipped', reason: 'edit_set_aborted' }, { status: 'changed' }] });
    expect(await readFile(join(root, 'b.ts'), 'utf8')).toBe(current);
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('new user file');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports the canonical writer refusal for read-only files', async () => {
    const dest = join(root, 'a.txt');
    await writeFile(dest, 'old');
    await chmod(dest, 0o444);
    const result = await apply({ kind: 'replace', matcher, files: [{ path: 'a.txt', expectedHash: hash(Buffer.from('old')) }] });
    expect(result).toMatchObject({ results: [{ status: 'failed', reason: 'file_replace_failed' }] });
    expect(await readFile(dest, 'utf8')).toBe('old');
  });

  it('reports every unattempted file on cancellation', async () => {
    const controller = new AbortController(); controller.abort();
    expect(await apply({ kind: 'replace', matcher, files: [{ path: 'a.txt', expectedHash: hash(Buffer.from('old')) }] }, controller.signal))
      .toEqual({ ok: true, results: [], cancelled: ['a.txt'] });
  });

  it('retains the cancelled apply acknowledgement and restores successful files byte-for-byte', async () => {
    const bytes = Buffer.from('\uFEFFold\r\n');
    for (const path of ['a.txt', 'b.txt']) await writeFile(join(root, path), bytes);
    const controller = new AbortController();
    const remote = new AbortController();
    const { writeFile: write } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(filesystem.writeFile).mockImplementation(async (path, data, options) => {
      await write(path, data, options);
      controller.abort();
    });
    // Only the network is adapted: cancellation reaches the daemon signal,
    // while the shared caller, handler, decoder, inverse edits and writer are real.
    const socket = {
      connected: true,
      emit: (event: string, payload: unknown) => {
        expect(event).toBe('rpc-cancel');
        expect(payload).toEqual({ requestId: 'replace-cancel-test' });
        remote.abort();
      },
      emitWithAck: async (_event: string, payload: unknown) => {
        expect(payload).toMatchObject({ waitForResultOnCancel: true });
        const request = (payload as { params: unknown }).params;
        const result = await applyWorkspaceFileReplace(request, root, { kind: 'osUser' }, { signal: remote.signal });
        return { ok: true, result };
      },
    };
    const result = DaemonWorkspaceFileReplaceApplyResponseSchema.parse(await callSocketRpc({ socket,
      target: { kind: 'machine', id: 'machine' }, method: RPC_METHODS.DAEMON_WORKSPACE_FILES_REPLACE_APPLY,
      params: { rootPath: root, operation: { kind: 'replace', matcher, files: ['a.txt', 'b.txt'].map(path => ({ path, expectedHash: hash(bytes) })) } },
      content: { mode: 'plain' }, requestId: 'replace-cancel-test', signal: controller.signal, waitForResultOnCancel: true,
    }));
    expect(result).toMatchObject({ results: [{ path: 'a.txt', status: 'replaced' }], cancelled: ['b.txt'] });
    expect(await readFile(join(root, 'a.txt'))).toEqual(Buffer.from('\uFEFFnew\r\n'));
    expect(await readFile(join(root, 'b.txt'))).toEqual(bytes);
    if (!result.ok) return;
    expect(await apply({ kind: 'restore', files: result.results.map(file => ({ path: file.path, expectedHash: file.hash, edits: file.edits })) }))
      .toMatchObject({ results: [{ status: 'restored' }] });
    expect(await readFile(join(root, 'a.txt'))).toEqual(bytes);
  });

  it('continues bounded previews without losing or reselecting matches across pages', async () => {
    for (const path of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) await writeFile(join(root, path), 'old\n'.repeat(1000));
    const paths: string[] = [];
    let cursor: { path: string } | undefined;
    do {
      const page = await preview({ contextLines: 0, ...(cursor ? { cursor } : {}) });
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      paths.push(...page.files.map(file => file.path));
      cursor = page.cursor;
      expect(page.hasMore).toBe(Boolean(cursor));
    } while (cursor);
    expect(paths).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt']);
  });

  it('skips invalid UTF8 and binary bytes while preserving text preview/apply parity', async () => {
    await writeFile(join(root, 'invalid.txt'), Buffer.from([255, ...Buffer.from('old')]));
    await writeFile(join(root, 'binary.txt'), Buffer.from('old\0bytes'));
    await writeFile(join(root, 'plain.txt'), 'old old\r\n');
    const page = await preview();
    expect(page).toMatchObject({ ok: true, skipped: { notText: 2 }, files: [{ path: 'plain.txt', matchCount: 2 }] });
    if (!page.ok) return;
    const result = await apply({ kind: 'replace', matcher, files: page.files.map(file => ({ path: file.path, expectedHash: file.hash })) });
    expect(result).toMatchObject({ ok: true, results: [{ matchCount: page.files[0].matchCount }] });
  });

  it('uses JavaScript lookaround for preview and guarded apply after native discovery fallback', async () => {
    await writeFile(join(root, 'a.txt'), 'old token old other\n');
    const matcher = { query: 'old(?= token)', replacement: 'new', regex: true, matchCase: true };
    const page = await preview(matcher);
    expect(page).toMatchObject({ ok: true, files: [{ path: 'a.txt', matchCount: 1 }] });
    if (!page.ok) return;
    expect(await apply({ kind: 'replace', matcher, files: page.files.map(file => ({ path: file.path, expectedHash: file.hash })) }))
      .toMatchObject({ ok: true, results: [{ status: 'replaced', matchCount: 1 }] });
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('new token old other\n');
  });

  it('discovers zero-width matches in empty files and keeps JavaScript word-boundary semantics', async () => {
    await writeFile(join(root, 'empty.txt'), '');
    await writeFile(join(root, 'unicode.txt'), 'éfoo');
    const empty = await preview({ query: '^$', replacement: 'new', regex: true });
    expect(empty).toMatchObject({ ok: true, files: [{ path: 'empty.txt', matchCount: 1 }] });
    expect(await preview({ query: '\\bfoo', regex: true })).toMatchObject({ ok: true, files: [{ path: 'unicode.txt', matchCount: 1 }] });
  });

  it('does not write when the inverse edits cannot fit the transport result', async () => {
    await writeFile(join(root, 'a.txt'), 'old old');
    const result = await apply({ kind: 'replace', matcher: { ...matcher, replacement: 'n'.repeat(WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES / 2) },
      files: [{ path: 'a.txt', expectedHash: hash(Buffer.from('old old')) }] });
    expect(result).toMatchObject({ results: [{ status: 'failed', reason: 'transport_ceiling' }] });
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('old old');
  });

  it('reports incomplete coverage for an indivisible oversized file while keeping readable results', async () => {
    await writeFile(join(root, 'huge.txt'), `${'old '.repeat(3000)}\n`);
    await writeFile(join(root, 'small.txt'), 'old\n');
    const page = await preview();
    expect(page).toMatchObject({ ok: true, coverage: 'partial', hasMore: false, files: [{ path: 'small.txt' }] });
    if (page.ok) expect(page.files).toHaveLength(1);
  });
});
