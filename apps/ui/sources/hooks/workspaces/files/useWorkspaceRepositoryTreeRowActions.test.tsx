import * as React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';

installSessionFilesViewBoundaries();
beforeAll(prepareSessionFilesViewTestkit);
afterEach(standardCleanup);

describe('workspace tree mutation callbacks', () => {
    async function setup(success: boolean) {
        const fixture = await createSessionFilesViewFixture({ rootPath: '/repo', serverIdentityId: 'srv_tree_row_actions', rpc: () => success
            ? { success: true } : { success: false, error: 'Filesystem access denied' } });
        const { Modal } = await import('@/modal');
        vi.spyOn(Modal, 'prompt').mockResolvedValue('renamed');
        vi.spyOn(Modal, 'confirm').mockResolvedValue(true);
        const { useWorkspaceRepositoryTreeRowActions } = await import('./useWorkspaceRepositoryTreeRowActions');
        let actions: ReturnType<typeof useWorkspaceRepositoryTreeRowActions> | undefined;
        const changed = vi.fn();
        const refresh = vi.fn();
        function Harness() {
            actions = useWorkspaceRepositoryTreeRowActions({ workspaceScope: fixture.scope, writeActionsEnabled: true,
                expandedPaths: ['src', 'src/nested', 'other'], onExpandedPathsChange: changed, onRequestRefresh: refresh });
            return null;
        }
        const screen = await fixture.render(React.createElement(Harness));
        if (!actions) throw new Error('Tree actions were not rendered');
        return { fixture, screen, actions, changed, refresh };
    }

    it('renames through the rooted Action before remapping expansion and refreshing', async () => {
        const state = await setup(true);
        try {
            await act(async () => state.actions.onSelectRowMenuItem({ path: 'src', type: 'directory' }, 'repository-tree-menuitem-rename'));
            expect(state.fixture.requests).toContainEqual({ targetId: 'm1', method: 'daemon.filesystem.rename',
                payload: { rootPath: '/repo', from: '/repo/src', to: '/repo/renamed', overwrite: false } });
            expect(state.changed).toHaveBeenCalledWith(['renamed', 'renamed/nested', 'other']);
            expect(state.refresh).toHaveBeenCalledOnce();
        } finally { await state.fixture.dispose(); }
    });

    it('preserves expansion and refresh state when the filesystem owner refuses the rename', async () => {
        const state = await setup(false);
        try {
            await act(async () => state.actions.onSelectRowMenuItem({ path: 'src', type: 'directory' }, 'repository-tree-menuitem-rename'));
            expect(state.changed).not.toHaveBeenCalled();
            expect(state.refresh).not.toHaveBeenCalled();
        } finally { await state.fixture.dispose(); }
    });

    it('performs the confirmed recursive delete through the same rooted Action', async () => {
        const state = await setup(true);
        try {
            await act(async () => state.actions.onSelectRowMenuItem({ path: 'src', type: 'directory' }, 'repository-tree-menuitem-delete'));
            expect(state.fixture.requests).toContainEqual({ targetId: 'm1', method: 'daemon.filesystem.delete',
                payload: { rootPath: '/repo', path: '/repo/src', recursive: true } });
            expect(state.changed).toHaveBeenCalledWith(['other']);
            expect(state.refresh).toHaveBeenCalledOnce();
        } finally { await state.fixture.dispose(); }
    });
});

describe('tree file rename with importer updates', () => {
    const hash = 'a'.repeat(64);
    const importerEdits = { status: 'ok', kind: 'willRenameFiles', fileHash: hash, files: [
        { path: 'src/retry.ts', expectedHash: hash, edits: [], renameTo: 'src/attempt.ts' },
        { path: 'src/settings/SettingsModal.tsx', expectedHash: hash, edits: [
            { range: { start: { line: 0, character: 52 }, end: { line: 0, character: 62 } }, text: '../attempt' }] },
    ] };
    async function setup(preview: unknown) {
        const fixture = await createSessionFilesViewFixture({ rootPath: '/repo', serverIdentityId: 'srv_tree_row_actions', rpc: (request) =>
            request.method === 'daemon.lsp.query.v1' ? preview : { success: true } });
        const { Modal } = await import('@/modal');
        vi.spyOn(Modal, 'prompt').mockResolvedValue('src/attempt.ts');
        vi.spyOn(Modal, 'alert').mockImplementation(() => undefined as never);
        const shown: Array<Readonly<{ props?: Record<string, unknown> }>> = [];
        vi.spyOn(Modal, 'show').mockImplementation((config) => { shown.push(config as never); return 'review'; });
        const { useWorkspaceRepositoryTreeRowActions } = await import('./useWorkspaceRepositoryTreeRowActions');
        let actions: ReturnType<typeof useWorkspaceRepositoryTreeRowActions> | undefined;
        const refresh = vi.fn();
        function Harness() {
            actions = useWorkspaceRepositoryTreeRowActions({ workspaceScope: fixture.scope, writeActionsEnabled: true,
                expandedPaths: ['src'], onExpandedPathsChange: vi.fn(), onRequestRefresh: refresh });
            return null;
        }
        await fixture.render(React.createElement(Harness));
        if (!actions) throw new Error('Tree actions were not rendered');
        const rename = actions.onSelectRowMenuItem({ path: 'src/retry.ts', type: 'file' }, 'repository-tree-menuitem-rename');
        // The plain move is the rooted rename Action reaching the Machine.
        const plainMoves = () => fixture.requests.filter(request => request.method === 'daemon.filesystem.rename').length;
        return { fixture, shown, refresh, rename, plainMoves };
    }

    it('asks the language server first and shows its importer edits for review instead of moving the file', async () => {
        const state = await setup(importerEdits);
        try {
            await act(async () => { await vi.waitFor(() => expect(state.shown).toHaveLength(1)); });
            expect(state.fixture.requests).toContainEqual(expect.objectContaining({ method: 'daemon.lsp.query.v1',
                payload: expect.objectContaining({ rootPath: '/repo', path: 'src/retry.ts', newPath: 'src/attempt.ts', kind: 'willRenameFiles' }) }));
            expect(state.shown[0]?.props?.request).toMatchObject({ op: 'fileRename', newPath: 'src/attempt.ts', files: importerEdits.files });
            expect(state.plainMoves()).toBe(0);
            // The review applied the move with its importers; the tree only refreshes.
            await act(async () => { (state.shown[0]?.props?.onSettled as (o: string) => void)('done'); await state.rename; });
            expect(state.plainMoves()).toBe(0);
            expect(state.refresh).toHaveBeenCalledOnce();
        } finally { await state.fixture.dispose(); }
    });

    it('moves only the file when the person chooses Rename only in the review', async () => {
        const state = await setup(importerEdits);
        try {
            await act(async () => { await vi.waitFor(() => expect(state.shown).toHaveLength(1)); });
            await act(async () => { (state.shown[0]?.props?.onSettled as (o: string) => void)('renameOnly'); await state.rename; });
            expect(state.plainMoves()).toBe(1);
        } finally { await state.fixture.dispose(); }
    });

    it('keeps the plain move when no file needs an edit or no server answers', async () => {
        for (const preview of [{ status: 'ok', kind: 'willRenameFiles', fileHash: hash, files: [importerEdits.files[0]] },
            { status: 'unavailable', reason: 'no_capable_server' }]) {
            const state = await setup(preview);
            try {
                await act(async () => { await state.rename; });
                expect(state.shown).toEqual([]);
                expect(state.plainMoves()).toBe(1);
                expect(state.fixture.requests).toContainEqual(expect.objectContaining({ method: 'daemon.lsp.query.v1' }));
            } finally { await state.fixture.dispose(); }
        }
    });
});
