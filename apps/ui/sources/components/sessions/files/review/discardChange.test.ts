import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { createEncryptedTransferChunkEnvelope } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption';
import { createTransferManifestHasher } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferManifestHasher';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import type { DetailsTab } from '@/components/appShell/panes/model/appPaneReducer';
import { V2SessionListResponseSchema } from '@happier-dev/protocol/sessions/control/contract';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const rpc = vi.hoisted(() => ({ responses: [] as unknown[], requests: [] as unknown[] }));
const transfer = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>() }));
vi.mock('@/utils/system/runtimeFetch', async importOriginal => {
  const actual = await importOriginal<typeof import('@/utils/system/runtimeFetch')>();
  return { ...actual, runtimeFetch: (...args: Parameters<typeof fetch>) => String(args[0]).includes('/machine-transfers/direct/')
    ? transfer.fetch(...args) : actual.runtimeFetch(...args) };
});
// Keep Action approval, output validation, inverse application and notices real.
// The remote Machine RPC is the genuine network boundary.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: async (request: unknown) => {
    rpc.requests.push(request);
    if (request && typeof request === 'object' && 'method' in request && request.method === 'daemon.directTransfer.export.release') return { success: true };
    const response = rpc.responses.shift();
    if (response instanceof Error) throw response;
    return response;
  },
}));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
const { discardChange } = await import('./discardChange');
const { useHunkDiscard } = await import('@/components/workspaces/scm/review/hunkReview/useHunkDiscard');
const { useFileChangesReview } = await import('@/components/workspaces/files/file/changes/useFileChangesReview');
const { useAskSelectionTargetContext } = await import('@/components/ui/code/selection/useAskSelection');
const { readPresentationNotice, retirePresentationNotice, publishPresentationNotice } = await import('@/components/sessions/presentation/presentationNotices');

const messages = { discarded: 'discarded', restored: 'restored', kept_edited: 'kept', undone: 'undone', undo_conflict: 'undo conflict',
  undo: 'undo', moved_on: 'moved on', update_required: 'update required', unsupported: 'unsupported', unavailable: 'unavailable', unknown: 'unknown', note_failed: 'file changed; note delivery failed', undo_unavailable: 'file changed; Undo unavailable' };
const beforeHash = 'a'.repeat(64);
const afterHash = 'b'.repeat(64);

describe('comparison Discard and guarded Undo', () => {
  let serverId: string;
  beforeEach(async () => {
    rpc.requests.length = 0; rpc.responses.length = 0;
    transfer.fetch.mockReset(); transfer.fetch.mockRejectedValue(new Error('Unexpected transfer request'));
    retirePresentationNotice();
    await homes.reset(); await loadSyncSingletonForTests();
    serverId = await homes.addHome({ name: 'Review Home', serverUrl: 'https://discard-review.test', serverIdentityId: 'srv_discard_review', accountId: 'review-account', currentAccount: true });
    const sessions = V2SessionListResponseSchema.parse({ sessions: [], hasNext: false, nextCursor: null });
    homes.answer(serverId, '/v2/sessions', { body: sessions });
    homes.answer(serverId, '/v2/sessions/active', { body: sessions });
    const boundary = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://discard-review.test',
      serverIdentityId: 'srv_discard_review', accountId: 'review-account', machineId: 'm1',
      actionId: 'daemon.filesystem.writeFile', tokenEpoch: 0,
      execute: (input, context) => {
        expect(context.invocation).toMatchObject({ surface: 'ui', authority: 'present_user', caller: { kind: 'host' } });
        rpc.requests.push({ payload: input });
        const response = rpc.responses.shift();
        if (response instanceof Error) throw response;
        return response;
      },
    });
    homes.answer(serverId, '/v1/machines', { body: [boundary.machine] });
    homes.answer(serverId, 'GET /v1/machines/m1', { body: { machine: boundary.machine } });
    for (const path of ['/v1/actions/daemon.filesystem.writeFile/execution-authorization', '/v1/actions/daemon.filesystem.writeFile']) {
      homes.answer(serverId, path, { select: async (_input, request) => {
        const response = await boundary.handle(new URL(request.url), request.init);
        if (!response) throw new Error(`Unhandled Undo HTTP boundary: ${request.url}`);
        return { status: response.status, body: await response.json() };
      } });
    }
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await restoreConnectionToActiveServer({ token: homes.findByServerUrl('https://discard-review.test')!.token! });
  });
  afterEach(async () => {
    retirePresentationNotice(); await standardCleanup();
    const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    await disconnectActiveServerConnection(); await homes.reset();
  });
  const input = () => ({ target: { machineId: 'm1', rootPath: '/repo', serverId },
    entry: { kind: 'comparison' as const, path: 'a.txt', against: { source: { kind: 'workingTree' as const } }, changeKeys: ['key'], expectedHash: beforeHash },
    messages, readCurrentText: async () => '\ufeffold\r\n', refresh: async () => {} });

  it('publishes sticky Undo and restores exact inverse bytes guarded by the post-discard hash', async () => {
    rpc.responses.push({ success: true, entries: [{ path: 'a.txt', status: 'reverted', hashBefore: beforeHash, hashAfter: afterHash,
      inverseEdits: [{ startUtf16: 1, deleteLength: 3, insertText: 'old', originalText: 'new' }] }] }, { success: true, hash: beforeHash });
    const result = await discardChange(input());
    expect(result.ok).toBe(true);
    expect(readPresentationNotice()).toMatchObject({ sticky: true, message: 'discarded', undo: { label: 'undo' } });
    if (!result.ok || !result.undo) throw new Error('Undo must be available');
    expect(await Promise.all([result.undo(), result.undo()])).toEqual([{ success: true }, { success: true }]);
    expect(rpc.requests).toEqual(expect.arrayContaining([expect.objectContaining({ payload: expect.objectContaining({
      content: '77u/bmV3DQo=', expectedHash: afterHash,
    }) })]));
    expect(readPresentationNotice()).toMatchObject({ message: 'undone' });
    expect(rpc.responses).toHaveLength(0);
  });

  it('restores binary previous bytes without decoding as text and refuses a guarded Undo conflict', async () => {
    rpc.responses.push({ success: true, entries: [{ path: 'a.txt', status: 'restored', hashBefore: beforeHash, hashAfter: afterHash,
      previous: { inlineBase64: 'AP+ADQo=' } }] }, { success: false, errorCode: 'hash_mismatch', error: 'changed' });
    const { entry, ...rest } = input();
    const { changeKeys: _keys, ...wholeFile } = entry;
    const result = await discardChange({ ...rest, entry: wholeFile });
    if (!result.ok || !result.undo) throw new Error('Undo must be available');
    expect(await result.undo()).toEqual({ success: false });
    expect(rpc.requests).toEqual(expect.arrayContaining([expect.objectContaining({ payload: expect.objectContaining({
      content: 'AP+ADQo=', expectedHash: afterHash,
    }) })]));
    expect(readPresentationNotice()).toMatchObject({ message: 'undo conflict' });
    expect(await result.undo()).toEqual({ success: false });
    expect(rpc.responses).toHaveLength(0);
  });

  it('keeps a completed Discard and its Undo when note delivery fails', async () => {
    rpc.responses.push({ success: true, noteDelivery: { status: 'failed' }, entries: [{ path: 'a.txt', status: 'reverted',
      hashBefore: beforeHash, hashAfter: afterHash, inverseEdits: [{ startUtf16: 1, deleteLength: 3, insertText: 'old', originalText: 'new' }] }] });
    const result = await discardChange(input());
    expect(result).toMatchObject({ ok: true, noteDelivery: 'failed' });
    expect(result.ok && result.undo).toBeTypeOf('function');
    expect(readPresentationNotice()).toMatchObject({ severity: 'error', message: messages.note_failed, undo: { label: 'undo' } });
    expect(rpc.responses).toHaveLength(0);
  });

  it.each(['dismissed', 'replaced', 'same-key replacement'] as const)('retires a %s notice inverse without removing its successor', async retirement => {
    rpc.responses.push({ success: true, entries: [{ path: 'a.txt', status: 'reverted', hashBefore: beforeHash, hashAfter: afterHash,
      inverseEdits: [{ startUtf16: 1, deleteLength: 3, insertText: 'old', originalText: 'new' }] }] });
    const result = await discardChange(input());
    if (!result.ok || !result.undo) throw new Error('Undo must be available');
    const original = readPresentationNotice()!;
    if (retirement === 'dismissed') retirePresentationNotice(original.key);
    else publishPresentationNotice({ key: retirement === 'same-key replacement' ? original.key : 'new-operation', message: 'new notice', severity: 'info' });
    const successor = readPresentationNotice();
    const requestsBeforeUndo = rpc.requests.length;
    expect(await result.undo()).toEqual({ success: false });
    expect(rpc.requests).toHaveLength(requestsBeforeUndo);
    expect(readPresentationNotice()).toBe(successor);
  });

  it('removes keyboard Undo availability as soon as its notice is dismissed', async () => {
    rpc.responses.push({ success: true, entries: [{ path: 'a.txt', status: 'reverted', hashBefore: beforeHash, hashAfter: afterHash,
      inverseEdits: [{ startUtf16: 1, deleteLength: 3, insertText: 'old', originalText: 'new' }] }] });
    const result = await discardChange(input());
    const hook = await renderHook(() => useHunkDiscard({ scope: { machineId: 'm1', rootPath: '/repo', serverId },
      sessionId: null, machineName: 'Machine', unreachable: false, refresh: () => {} }));
    await act(async () => { hook.getCurrent().remember(result); });
    expect(hook.getCurrent().undoAvailable).toBe(true);
    await act(async () => { retirePresentationNotice(); });
    expect(hook.getCurrent().undoAvailable).toBe(false);
    const count = rpc.requests.length;
    await act(async () => { hook.getCurrent().undo(); });
    expect(rpc.requests).toHaveLength(count);
  });

  it('retires a just-remembered inverse in the same React batch', async () => {
    rpc.responses.push({ success: true, entries: [{ path: 'a.txt', status: 'restored', hashBefore: beforeHash, hashAfter: afterHash,
      previous: { inlineBase64: 'b2xkCg==' } }] });
    const result = await discardChange(input());
    if (!result.ok || !result.undo) throw new Error('Undo must be available');
    const hook = await renderHook(() => useHunkDiscard({ scope: { machineId: 'm1', rootPath: '/repo', serverId },
      sessionId: null, machineName: 'Machine', unreachable: false, refresh: () => {} }));
    await act(async () => { hook.getCurrent().remember(result); hook.getCurrent().retireUndo(); });
    expect(hook.getCurrent().undoAvailable).toBe(false);
    expect(readPresentationNotice()).toBeNull();
    const count = rpc.requests.length;
    expect(await result.undo()).toEqual({ success: false });
    expect(rpc.requests).toHaveLength(count);
  });

  it('retains File-page restore Undo on the same file until used, and retires it on file change or unmount', async () => {
    const hook = await renderHook(({ path, rootPath = '/repo' }: { path: string; rootPath?: string }) => useFileChangesReview({
      scope: { machineId: 'm1', rootPath, serverId }, filePath: path,
      liveDiff: '@@ -1 +1 @@\n-old\n+new\n', refreshLiveDiff: () => {}, contentHash: beforeHash,
      view: { changesScope: { kind: 'workingTree' } }, onChangesScopeChange: () => {}, active: true,
    }), { initialProps: { path: 'a.txt' } });
    const restore = async () => {
      rpc.responses.push({ success: true, entries: [{ path: 'a.txt', status: 'restored', hashBefore: beforeHash, hashAfter: afterHash,
        previous: { inlineBase64: 'b2xkCg==' } }] });
      await act(async () => { await hook.getCurrent().menuChanges.discardAll?.(); });
      expect(hook.getCurrent().undoAvailable).toBe(true);
      expect(hook.getCurrent().keyboard.undo).toBeTypeOf('function');
      expect(readPresentationNotice()?.undo).toBeDefined();
    };
    await restore();
    await hook.rerender();
    expect(hook.getCurrent().undoAvailable).toBe(true);
    rpc.responses.push({ success: true, hash: beforeHash });
    await act(async () => { hook.getCurrent().keyboard.undo?.(); });
    expect(rpc.requests).toEqual(expect.arrayContaining([expect.objectContaining({ payload: expect.objectContaining({
      content: 'b2xkCg==', expectedHash: afterHash,
    }) })]));
    expect(hook.getCurrent().undoAvailable).toBe(false);
    await restore();
    const fileUndo = readPresentationNotice()!.undo!.run;
    await hook.rerender({ path: 'b.txt' });
    expect(readPresentationNotice()).toBeNull();
    expect(await fileUndo()).toEqual({ success: false });
    await hook.rerender({ path: 'a.txt' });
    await restore();
    const previousCheckoutUndo = readPresentationNotice()!.undo!.run;
    await hook.rerender({ path: 'a.txt', rootPath: '/other-repo' });
    expect(readPresentationNotice()).toBeNull();
    expect(await previousCheckoutUndo()).toEqual({ success: false });
    await hook.rerender({ path: 'a.txt' });
    await restore();
    const unmountedUndo = readPresentationNotice()!.undo!.run;
    await hook.unmount();
    expect(readPresentationNotice()).toBeNull();
    expect(await unmountedUndo()).toEqual({ success: false });
    expect(rpc.responses).toHaveLength(0);
  });

  it('offers project per-change Ask through the existing detached run destination', async () => {
    const opened: DetailsTab[] = [];
    const hook = await renderHook(() => {
      const getAskTargetContext = useAskSelectionTargetContext(React.useCallback(() => ({
        openDetailsTab: (tab: DetailsTab) => { opened.push(tab); },
      }), []));
      return useFileChangesReview({
        scope: { machineId: 'm1', rootPath: '/repo', serverId }, filePath: 'a.txt',
        liveDiff: '@@ -1 +1 @@\n-old\n+new\n', refreshLiveDiff: () => {},
        view: { changesScope: { kind: 'workingTree' } }, onChangesScopeChange: () => {}, active: true,
        getAskTargetContext,
      });
    });
    expect(hook.getCurrent().keyboard.askCurrent).toBeTypeOf('function');
    rpc.responses.push({ protocolVersion: 1, results: { 'tool.executionRuns': { ok: true, checkedAt: Date.now(),
      data: { protocolVersion: 2, features: { detachedScope: true, exactInputResults: true } } } } });
    await act(async () => { hook.getCurrent().keyboard.askCurrent?.(); });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ kind: 'executionRunLauncher', resource: {
      sessionId: null, workspace: { machineId: 'm1', cwd: '/repo' }, initialInstructions: expect.stringContaining('new'),
    } });
    expect(opened[0]?.resource).toMatchObject({ initialInstructions: expect.stringContaining('a.txt:1') });
    expect(rpc.responses).toHaveLength(0);
  });

  it('reports Undo note failure separately from the successful one-shot file write', async () => {
    rpc.responses.push({ success: true, entries: [{ path: 'a.txt', status: 'reverted', hashBefore: beforeHash, hashAfter: afterHash,
      inverseEdits: [{ startUtf16: 1, deleteLength: 3, insertText: 'old', originalText: 'new' }] }] }, { success: true, hash: beforeHash });
    // The canonical sender refuses an unavailable Session; it must not turn an
    // already completed file write into a retryable mutation failure.
    const result = await discardChange({ ...input(), sessionTarget: { serverId, sessionId: 'unavailable-session' } });
    if (!result.ok || !result.undo) throw new Error('Undo must be available');
    expect(await result.undo()).toEqual({ success: true, noteDelivery: 'failed' });
    expect(await result.undo()).toEqual({ success: true, noteDelivery: 'failed' });
    expect(readPresentationNotice()).toMatchObject({ message: messages.note_failed, severity: 'error' });
    expect(rpc.responses).toHaveLength(0);
  });

  it('materializes exported Undo bytes before offering Undo and does not reopen the expiring descriptor later', async () => {
    const bytes = new Uint8Array([0, 255, 128, 13, 10]);
    const hasher = createTransferManifestHasher(); hasher.update(bytes);
    const manifestHash = hasher.digestManifestHash();
    const endpoint = 'http://127.0.0.1:46001/machine-transfers/direct/cHJldmlvdXM';
    let envelope: Awaited<ReturnType<typeof createEncryptedTransferChunkEnvelope>>;
    transfer.fetch.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/open')) {
        envelope = await createEncryptedTransferChunkEnvelope({ transferId: 'previous', sequence: 0, payload: bytes,
          recipientPublicKeyBase64: new Headers(init?.headers).get('x-happier-transfer-recipient-public-key')! });
        return new Response(JSON.stringify({ transferId: 'previous', totalChunks: 1, sizeBytes: bytes.length, manifestHash }), { headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/chunks/0')) return new Response(JSON.stringify({ transferId: 'previous', kind: 'chunk', sequence: 0, ...envelope }), { headers: { 'content-type': 'application/json' } });
      throw new Error('Unexpected transfer endpoint');
    });
    rpc.responses.push({ success: true, entries: [{ path: 'a.txt', status: 'restored', hashBefore: beforeHash, hashAfter: afterHash,
      previous: { export: { transferId: 'previous', name: 'a.txt', sizeBytes: bytes.length, manifestHash, expiresAt: Date.now() + 60_000,
        endpointCandidates: [{ kind: 'http', url: endpoint, expiresAt: Date.now() + 60_000 }] } } }] }, { success: true, hash: beforeHash });
    const result = await discardChange(input());
    expect(transfer.fetch).toHaveBeenCalled();
    expect(rpc.requests).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'daemon.directTransfer.export.release' })]));
    if (!result.ok || !result.undo) throw new Error('Materialized Undo must be available');
    transfer.fetch.mockClear(); transfer.fetch.mockRejectedValue(new Error('Descriptor expired'));
    expect(await result.undo()).toEqual({ success: true });
    expect(transfer.fetch).not.toHaveBeenCalled();
    expect(rpc.requests).toEqual(expect.arrayContaining([expect.objectContaining({ payload: expect.objectContaining({ content: 'AP+ADQo=', expectedHash: afterHash }) })]));
  });

  it('reports unavailable Undo after a failed preimage download without replaying the completed mutation', async () => {
    rpc.responses.push({ success: true, entries: [{ path: 'a.txt', status: 'restored', hashBefore: beforeHash, hashAfter: afterHash,
      previous: { export: { transferId: 'previous', name: 'a.txt', sizeBytes: 1, manifestHash: `sha256:${'a'.repeat(64)}`,
        expiresAt: Date.now() + 60_000, endpointCandidates: [] } } }] });
    const result = await discardChange(input());
    expect(result).toMatchObject({ ok: true, undoUnavailable: true });
    expect(result).not.toHaveProperty('undo');
    expect(readPresentationNotice()).toMatchObject({ severity: 'error', message: messages.undo_unavailable });
    expect(rpc.responses).toHaveLength(0);
  });

  it.each([['FILE_CHANGED', 'moved_on'], ['CHANGE_MOVED_ON', 'moved_on'], ['INVALID_REQUEST', 'update_required']] as const)(
    'surfaces %s and refreshes without another mutation', async (errorCode, reason) => {
      rpc.responses.push({ success: false, errorCode, error: 'refused' });
      let refreshed = false;
      expect(await discardChange({ ...input(), refresh: async () => { refreshed = true; } })).toEqual({ ok: false, reason });
      expect(refreshed).toBe(true);
      expect(rpc.responses).toHaveLength(0);
      expect(readPresentationNotice()?.undo).toBeUndefined();
    });

  it.each(['recreated', 'kept_edited'] as const)('offers no Undo for %s when nothing was overwritten', async status => {
    rpc.responses.push({ success: true, entries: [{ path: 'a.txt', status, hashBefore: null, hashAfter: afterHash }] });
    const result = await discardChange(input());
    expect(result).toMatchObject({ ok: true, entry: { status } });
    expect(result.ok && result.fileReplaced).toBe(status !== 'kept_edited');
    expect(result).not.toHaveProperty('undo');
    expect(readPresentationNotice()?.undo).toBeUndefined();
  });
});
