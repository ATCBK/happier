import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act, renderHook } from '@/dev/testkit';
import {
  readPresentationNotice,
  retirePresentationNotice,
} from '@/components/sessions/presentation/presentationNotices';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import {
  useWorkspaceReplace,
  type WorkspaceReplacePreviewFile,
} from '@/sync/domains/workspaces/files/workspaceFileReplace';

import { useReplaceUndoOnClose } from './useReplaceUndoOnClose';

const rpc = vi.hoisted(() => ({ call: vi.fn() }));
// The Machine network transport is the only mocked boundary; the replace owner and the notice owner stay real.
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
const scope = { serverId: 'home', machineId: 'mac', rootPath: '/repo' };
const account: ServerAccountScopeLifetime = {
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
  beforeEach(() => {
    rpc.call.mockReset();
    retirePresentationNotice();
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
      await Promise.resolve();
      await Promise.resolve();
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
