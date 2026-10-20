import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseUnifiedDiffHunks } from '@happier-dev/protocol/diff/hunks';

import { act, flushHookEffects, renderHook } from '@/dev/testkit';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import {
  buildReplaceApplyFiles,
  buildReplacePreviewUnifiedDiff,
  previewReplacedLine,
  replaceFileSelection,
  replaceMatchKey,
  summarizeReplaceResults,
  useWorkspaceReplace,
  type WorkspaceReplaceMatcher,
  type WorkspaceReplacePreviewFile,
} from './workspaceFileReplace';

const rpc = vi.hoisted(() => ({ call: vi.fn() }));
// The Machine network transport is the only mocked boundary; schemas, the op and the pure replace function stay real.
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => ({
    machineRpcWithServerScope: (input: unknown) => rpc.call(input),
  }),
);

const hash = (c: string) => c.repeat(64);
const matcher: WorkspaceReplaceMatcher = {
  query: 'useSettingsRouteKey',
  replacement: 'useSettingsModalKey',
  matchCase: false,
  regex: false,
};
const modal: WorkspaceReplacePreviewFile = {
  path: 'apps/ui/settings/SettingsModal.tsx',
  hash: hash('a'),
  matchCount: 3,
  matches: [
    {
      line: 5,
      column16: 10,
      length16: 19,
      text: "import { useSettingsRouteKey } from './useSettingsRouteKey';",
      replacedText:
        "import { useSettingsModalKey } from './useSettingsModalKey';",
      before: [
        "import { Modal } from './Modal';",
        "import { Body } from './Body';",
      ],
      after: ["import type { Route } from './routes';", 'const key = useSettingsRouteKey(route);'],
    },
    {
      line: 5,
      column16: 40,
      length16: 19,
      text: "import { useSettingsRouteKey } from './useSettingsRouteKey';",
      replacedText:
        "import { useSettingsModalKey } from './useSettingsModalKey';",
      before: [
        "import { Modal } from './Modal';",
        "import { Body } from './Body';",
      ],
      after: ["import type { Route } from './routes';", 'const key = useSettingsRouteKey(route);'],
    },
    {
      line: 7,
      column16: 13,
      length16: 19,
      text: 'const key = useSettingsRouteKey(route);',
      replacedText: 'const key = useSettingsModalKey(route);',
      before: ["import { useSettingsRouteKey } from './useSettingsRouteKey';", "import type { Route } from './routes';"],
      after: ['', 'return key;'],
    },
  ],
};
const doc: WorkspaceReplacePreviewFile = {
  path: 'docs/settings-modal.md',
  hash: hash('b'),
  matchCount: 1,
  matches: [
    {
      line: 2,
      column16: 5,
      length16: 19,
      text: 'Use useSettingsRouteKey here',
      replacedText: 'Use useSettingsModalKey here',
      before: ['# Modal'],
      after: [],
    },
  ],
};

function lifetime(): ServerAccountScopeLifetime {
  return {
    scope: { serverId: 'home', accountId: 'acct' },
    isCurrent: () => true,
    onRetire: () => ({ dispose: () => {} }),
  };
}

describe('replace review model', () => {
  it('derives the file checkbox from its matches and sends only the matches left selected', () => {
    const excluded = new Map([
      [modal.path, new Set([replaceMatchKey(modal.matches[1]!)])],
      [doc.path, new Set([replaceMatchKey(doc.matches[0]!)])],
    ]);
    expect(replaceFileSelection(modal, excluded)).toEqual({
      selected: 2,
      total: 3,
      state: 'some',
    });
    expect(replaceFileSelection(doc, excluded)).toEqual({
      selected: 0,
      total: 1,
      state: 'none',
    });
    const third: WorkspaceReplacePreviewFile = {
      ...doc,
      path: 'src/dirty.ts',
      hash: hash('c'),
    };
    expect(
      buildReplaceApplyFiles([modal, doc, third], excluded, ['src/dirty.ts']),
    ).toEqual([
      {
        path: modal.path,
        expectedHash: hash('a'),
        excludedMatches: [{ line: 5, column16: 40 }],
      },
    ]);
  });

  it('marks only the selected matches of a line as replaced', () => {
    const excluded = new Set([replaceMatchKey(modal.matches[1]!)]);
    expect(previewReplacedLine(modal, 5, matcher, excluded)).toBe(
      "import { useSettingsModalKey } from './useSettingsRouteKey';",
    );
    expect(previewReplacedLine(modal, 5, matcher, new Set())).toBe(
      "import { useSettingsModalKey } from './useSettingsModalKey';",
    );
  });

  it('builds a standard unified patch from the preview that the shared hunk parser reads, merging nearby matches', () => {
    const patch = buildReplacePreviewUnifiedDiff(
      modal,
      matcher,
      new Set([replaceMatchKey(modal.matches[1]!)]),
    );
    const hunks = parseUnifiedDiffHunks(patch);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ oldStart: 3, newStart: 3 });
    expect(
      hunks[0]!.lines
        .filter((line) => line.kind === 'remove')
        .map((line) => line.text),
    ).toEqual([modal.matches[0]!.text, modal.matches[2]!.text]);
    expect(
      hunks[0]!.lines
        .filter((line) => line.kind === 'add')
        .map((line) => line.text),
    ).toEqual([
      "import { useSettingsModalKey } from './useSettingsRouteKey';",
      'const key = useSettingsModalKey(route);',
    ]);
    // A file whose matches are all left out shows no change.
    expect(
      parseUnifiedDiffHunks(
        buildReplacePreviewUnifiedDiff(
          doc,
          matcher,
          new Set([replaceMatchKey(doc.matches[0]!)]),
        ),
      ),
    ).toHaveLength(0);
  });

  it('counts per-file outcomes for the result summary', () => {
    expect(
      summarizeReplaceResults([
        { path: 'a', status: 'replaced', matchCount: 2 },
        { path: 'b', status: 'replaced', matchCount: 1 },
        { path: 'c', status: 'changed' },
        { path: 'd', status: 'skipped', reason: 'unsaved' },
        { path: 'e', status: 'cancelled' },
      ]),
    ).toEqual({
      replacedFiles: 2,
      replacedMatches: 3,
      changed: 1,
      skipped: 1,
      failed: 0,
      cancelled: 1,
      restored: 0,
    });
  });
});

describe('useWorkspaceReplace', () => {
    beforeEach(() => { rpc.call.mockReset(); });
    const scope = { serverId: 'home', machineId: 'mac', rootPath: '/repo' };
    const previewOk = { ok: true, files: [modal, doc], skipped: { notText: 1 }, hasMore: false, coverage: 'complete' };
    const account = lifetime();

    it('re-previews on every replacement change and holds apply until the preview matches what is typed', async () => {
        let resolveSecond: (value: unknown) => void = () => {};
        rpc.call.mockResolvedValueOnce(previewOk).mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
        const hook = await renderHook((props: { replacement: string }) => useWorkspaceReplace({
            scope, accountLifetime: account, matcher: { ...matcher, replacement: props.replacement }, unsavedPaths: [],
        }), { initialProps: { replacement: 'useSettingsModalKey' } });
        expect(hook.getCurrent().preview?.files).toHaveLength(2);
        expect(hook.getCurrent().canApply).toBe(true);
        await hook.rerender({ replacement: 'useSettingsKey' });
        // The last preview stays readable while the new one loads; apply waits.
        expect(hook.getCurrent().preview?.files).toHaveLength(2);
        expect(hook.getCurrent().stale).toBe(true);
        expect(hook.getCurrent().canApply).toBe(false);
        expect(rpc.call).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'daemon.workspaceFiles.replace.preview.v1',
            payload: expect.objectContaining({ replacement: 'useSettingsKey', rootPath: '/repo' }) }));
        await act(async () => { resolveSecond(previewOk); });
        await flushHookEffects();
        expect(hook.getCurrent().stale).toBe(false);
        expect(hook.getCurrent().canApply).toBe(true);
    });

    it('applies the reviewed selection, skips unsaved files, and undoes with the recorded edits', async () => {
        const edits = [{ startUtf16: 9, deleteLength: 19, insertText: 'useSettingsModalKey', originalText: 'useSettingsRouteKey' }];
        rpc.call.mockResolvedValueOnce(previewOk)
            .mockResolvedValueOnce({ ok: true, results: [{ path: modal.path, status: 'replaced', hash: hash('d'), matchCount: 3, edits }] })
            .mockResolvedValueOnce({ ok: true, results: [{ path: modal.path, status: 'restored', hash: hash('a') }] });
        const unsavedPaths = [doc.path];
        const hook = await renderHook(() => useWorkspaceReplace({ scope, accountLifetime: account, matcher, unsavedPaths }));
        expect(hook.getCurrent().canApply).toBe(true);
        expect(hook.getCurrent().unsavedFiles.map((file) => file.path)).toEqual([doc.path]);
        expect(hook.getCurrent().totals).toMatchObject({ selectedFiles: 1, selectedMatches: 3 });
        await act(async () => { await hook.getCurrent().apply(); });
        expect(rpc.call.mock.calls[1]![0]).toMatchObject({ method: 'daemon.workspaceFiles.replace.apply.v1', payload: { rootPath: '/repo',
            operation: { kind: 'replace', matcher, files: [{ path: modal.path, expectedHash: hash('a') }] } } });
        expect(hook.getCurrent().results?.map((entry) => [entry.path, entry.status])).toEqual([[modal.path, 'replaced'], [doc.path, 'skipped']]);
        expect(hook.getCurrent().canUndo).toBe(true);
        await act(async () => { await hook.getCurrent().undo(); });
        expect(rpc.call.mock.calls[2]![0]).toMatchObject({ payload: { operation: { kind: 'restore', files: [{ path: modal.path, expectedHash: hash('d'), edits }] } } });
        expect(hook.getCurrent().results?.[0]?.status).toBe('restored');
        expect(hook.getCurrent().canUndo).toBe(false);
    });

    it('reports a file changed since the replace when Undo finds other bytes', async () => {
        const edits = [{ startUtf16: 4, deleteLength: 19, insertText: 'useSettingsModalKey', originalText: 'useSettingsRouteKey' }];
        rpc.call.mockResolvedValueOnce(previewOk)
            .mockResolvedValueOnce({ ok: true, results: [{ path: doc.path, status: 'replaced', hash: hash('e'), matchCount: 1, edits },
                { path: modal.path, status: 'changed' }] })
            .mockResolvedValueOnce({ ok: true, results: [{ path: doc.path, status: 'changed' }] });
        const unsavedPaths: string[] = [];
        const hook = await renderHook(() => useWorkspaceReplace({ scope, accountLifetime: account, matcher, unsavedPaths }));
        await act(async () => { await hook.getCurrent().apply(); });
        expect(summarizeReplaceResults(hook.getCurrent().results ?? [])).toMatchObject({ replacedFiles: 1, changed: 1 });
        await act(async () => { await hook.getCurrent().undo(doc.path); });
        expect(hook.getCurrent().results?.find((entry) => entry.path === doc.path)?.status).toBe('undoChanged');
    });
});
