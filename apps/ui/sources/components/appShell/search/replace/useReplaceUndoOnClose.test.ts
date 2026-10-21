import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceFilesReplaceActionInputSchema } from '@happier-dev/protocol/actions/actionSpecs';

import { act, renderHook, standardCleanup } from '@/dev/testkit';
import {
  readPresentationNotice,
  retirePresentationNotice,
} from '@/components/sessions/presentation/presentationNotices';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { WorkspaceReplacePreviewFile } from '@/sync/domains/workspaces/files/workspaceFileReplace';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';

import { useReplaceUndoOnClose } from './useReplaceUndoOnClose';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { useWorkspaceReplace } = await import('@/sync/domains/workspaces/files/workspaceFileReplace');

const rpc = vi.hoisted(() => ({ call: vi.fn() }));
// Machine RPC and admitted Action HTTP are transport boundaries; the state and notice owners stay real.
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => ({
    machineRpcWithServerScope: (input: unknown) => rpc.call(input),
  }),
);

const hash = (c: string) => c.repeat(64);
const matcher = {
  query: 'retry',
  replacement: 'retryWithPolicy',
  matchCase: false,
  regex: false,
};
const file: WorkspaceReplacePreviewFile = {
  path: 'src/retry.ts',
  hash: hash('a'),
  matchCount: 1,
  matches: [
    {
      line: 3,
      column16: 17,
      length16: 5,
      text: 'export function retry() {}',
      replacedText: 'export function retryWithPolicy() {}',
      before: [],
      after: [],
    },
  ],
};
const edits = [
  {
    startUtf16: 16,
    deleteLength: 15,
    insertText: 'retry',
    originalText: 'retryWithPolicy',
  },
];
let scope = { serverId: 'home', machineId: 'mac', rootPath: '/repo' };
let account: ServerAccountScopeLifetime = {
  scope: { serverId: 'home', accountId: 'acct' },
  isCurrent: () => true,
  onRetire: () => ({ dispose: () => {} }),
};
const unsavedPaths: string[] = [];

function useSurface() {
  const model = useWorkspaceReplace({
    scope,
    accountLifetime: account,
    matcher,
    unsavedPaths,
  });
  useReplaceUndoOnClose(model, 'NLDW3');
  return model;
}

describe('useReplaceUndoOnClose', () => {
  beforeEach(async () => {
    await homes.reset(); rpc.call.mockReset();
    scope = { ...scope, serverId: await homes.addHome({ name: 'Replace Home', serverUrl: 'https://replace-notice.test',
      serverIdentityId: 'srv_replace_notice', accountId: 'acct', currentAccount: true, active: false }) };
    account = { ...account, scope: { serverId: scope.serverId, accountId: 'acct' } };
    const boundary = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://replace-notice.test',
      serverIdentityId: 'srv_replace_notice', accountId: 'acct', machineId: 'mac', actionId: 'workspace.files.replace', tokenEpoch: 0,
      execute: async (request, context) => {
        const { machineId, ...payload } = WorkspaceFilesReplaceActionInputSchema.parse(request);
        return rpc.call({ method: 'workspace.files.replace', machineId, payload, serverId: scope.serverId,
          accountId: 'acct', signal: context.signal });
      },
    });
    homes.answer(scope.serverId, '/v1/machines', { body: [boundary.machine] });
    for (const path of ['/v1/actions/workspace.files.replace/execution-authorization', '/v1/actions/workspace.files.replace']) {
      homes.answer(scope.serverId, path, { select: async (_body, request) => {
        const response = await boundary.handle(new URL(request.url), request.init);
        if (!response) throw new Error('Unhandled replacement Action request');
        return { status: response.status, body: await response.json() };
      } });
    }
    retirePresentationNotice();
  });
  afterEach(async () => { standardCleanup(); await homes.reset(); });

  it('keeps the originating Undo when a late reply arrives after selecting another folder and closing', async () => {
    let completeApply: (value: unknown) => void = () => {};
    rpc.call.mockResolvedValueOnce({ ok: true, files: [file], skipped: { notText: 0 }, hasMore: false, coverage: 'complete' })
      .mockImplementationOnce(() => new Promise(resolve => { completeApply = resolve; }))
      .mockResolvedValueOnce({ ok: true, files: [file], skipped: { notText: 0 }, hasMore: false, coverage: 'complete' })
      .mockResolvedValueOnce({ ok: true, results: [{ path: file.path, status: 'restored', hash: hash('a') }] });
    const hook = await renderHook((currentScope: typeof scope) => {
      const model = useWorkspaceReplace({ scope: currentScope, accountLifetime: account, matcher, unsavedPaths });
      useReplaceUndoOnClose(model, 'NLDW3');
      return model;
    }, { initialProps: scope });
    let applying: Promise<void> = Promise.resolve();
    await act(async () => { applying = hook.getCurrent().apply(); });
    await hook.rerender({ ...scope, rootPath: '/other' });
    await act(async () => {
      completeApply({ ok: true, results: [{ path: file.path, status: 'replaced', hash: hash('d'), matchCount: 1, edits }] });
      await applying;
    });
    expect(hook.getCurrent().results).toBeNull();
    await hook.unmount();
    const notice = readPresentationNotice();
    expect(notice?.undo).toBeDefined();
    await act(async () => {
      notice!.undo!.run();
      await waitForHomeGovernance(() => expect(readPresentationNotice()?.undo).toBeUndefined());
    });
    expect(rpc.call.mock.lastCall?.[0]).toMatchObject({ machineId: 'mac', serverId: scope.serverId, accountId: 'acct',
      payload: { rootPath: '/repo', operation: { kind: 'restore', files: [{ path: file.path, expectedHash: hash('d'), edits }] } } });
  });

  it('hands Undo to a sticky notice only when the surface closes while Undo is still possible', async () => {
    rpc.call
      .mockResolvedValueOnce({
        ok: true,
        files: [file],
        skipped: { notText: 0 },
        hasMore: false,
        coverage: 'complete',
      })
      .mockResolvedValueOnce({
        ok: true,
        results: [
          {
            path: file.path,
            status: 'replaced',
            hash: hash('d'),
            matchCount: 1,
            edits,
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        results: [{ path: file.path, status: 'restored', hash: hash('a') }],
      });
    const hook = await renderHook(() => useSurface());
    await act(async () => {
      await hook.getCurrent().apply();
    });
    // While the surface is open, its result row owns Undo: no second Undo elsewhere.
    expect(readPresentationNotice()).toBeNull();
    await hook.unmount();
    const notice = readPresentationNotice();
    expect(notice).toMatchObject({
      sticky: true,
      undo: { label: expect.any(String) },
    });
    await act(async () => {
      notice!.undo!.run();
      await waitForHomeGovernance(() => expect(readPresentationNotice()?.undo).toBeUndefined());
    });
    expect(rpc.call.mock.calls[2]![0]).toMatchObject({
      payload: {
        operation: {
          kind: 'restore',
          files: [{ path: file.path, expectedHash: hash('d'), edits }],
        },
      },
    });
    // The notice now reports the outcome and offers no Undo of its own.
    expect(readPresentationNotice()?.undo).toBeUndefined();
    expect(readPresentationNotice()?.severity).toBe('info');
  });

  it('leaves no notice when the surface closes with nothing left to undo', async () => {
    rpc.call
      .mockResolvedValueOnce({
        ok: true,
        files: [file],
        skipped: { notText: 0 },
        hasMore: false,
        coverage: 'complete',
      })
      .mockResolvedValueOnce({
        ok: true,
        results: [
          {
            path: file.path,
            status: 'replaced',
            hash: hash('d'),
            matchCount: 1,
            edits,
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        results: [{ path: file.path, status: 'restored', hash: hash('a') }],
      });
    const hook = await renderHook(() => useSurface());
    await act(async () => {
      await hook.getCurrent().apply();
    });
    await act(async () => {
      await hook.getCurrent().undo();
    });
    await hook.unmount();
    expect(readPresentationNotice()).toBeNull();
  });
});
