import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionListRenderableSessionFixture, standardCleanup } from '@/dev/testkit';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from './sessionFilesViewTestkit';

installSessionFilesViewBoundaries();
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit')).createTextModuleMock({ translate: (key, params) => params ? `${key}:${JSON.stringify(params)}` : key }));
await prepareSessionFilesViewTestkit();

const changedEntries = ['src/a.ts', 'src/b.ts', 'README.md', 'scratch/'].map(path => ({
    path, previousPath: null, kind: path.endsWith('/') ? 'untracked' as const : 'modified' as const,
    includeStatus: '', pendingStatus: '', hasIncludedDelta: false, hasPendingDelta: true,
    stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0, isBinary: false },
}));

describe('Session shared browser changed-only, header and View menu', () => {
    let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
    const secondary: Array<Awaited<ReturnType<typeof createSessionFilesViewFixture>>> = [];
    let fixtureIndex = 0;
    beforeEach(async () => {
        const rootPath = `/changed-browser-${++fixtureIndex}`;
        const snapshot = fileViewSnapshot({ rootPath, entries: changedEntries });
        fixture = await createSessionFilesViewFixture({ rootPath, rpc: request => request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT
            ? { success: true, snapshot } : request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY
                ? { ok: true, path: (request.payload as { path: string }).path, truncated: false, gitIgnoreAvailable: true, entries: [] } : { success: false, error: 'Unavailable boundary operation' } });
        fixture.setSnapshot(snapshot);
        fixture.storage.getState().setSessionRepositoryTreeExpandedPaths('s1', ['src']);
    });
    afterEach(async () => {
        standardCleanup();
        for (const item of secondary.reverse()) await item.dispose();
        secondary.length = 0;
        await fixture.dispose();
    });

    async function render(serverId = fixture.scope.serverId) {
        const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');
        const screen = await fixture.render(<SessionRepositoryTreeBrowserView sessionId="s1" serverId={serverId} onOpenFile={() => {}} />);
        await vi.waitFor(() => expect(screen.findByTestId('repository-tree-filter-changed')).not.toBeNull());
        return screen;
    }
    const rowId = (path: string) => `repository-tree-row-${toTestIdSafeValue(path)}`;

    it('prunes the same tree in place and restores all files through the changed-only chip', async () => {
        const { WorkspaceRepositoryTreeList } = await import('@/components/projects/files/WorkspaceRepositoryTreeList');
        const screen = await render();
        const original = screen.findAllByType(WorkspaceRepositoryTreeList)[0];
        await screen.pressByTestIdAsync('repository-tree-filter-changed');
        expect(screen.findAllByType(WorkspaceRepositoryTreeList)[0]).toBe(original);
        for (const path of ['src/a.ts', 'src/b.ts', 'README.md']) expect(screen.findByTestId(rowId(path))).toBeTruthy();
        expect(screen.findByTestId(rowId('scratch/'))).toBeNull();
        expect(screen.findByTestId('repository-tree-changed-only-chip')).toBeTruthy();
        await screen.pressByTestIdAsync('repository-tree-changed-only-chip');
        expect(screen.findByTestId('repository-tree-changed-only-chip')).toBeNull();
        expect(screen.findByTestId(rowId('src/a.ts'))).toBeNull();
    });

    it('reads the working tree of the Home named by the route, not the active Home', async () => {
        const selectedHomeMachines = fixture.storage.getState().machineListByServerId[fixture.scope.serverId] ?? [];
        const other = await createSessionFilesViewFixture({ rootPath: fixture.scope.rootPath, serverUrl: 'https://other-session-files.test' });
        secondary.push(other);
        other.setSnapshot(fileViewSnapshot({ rootPath: fixture.scope.rootPath, entries: [{ ...changedEntries[0], path: 'other-home.ts' }] }));
        // Each fixture restores a cold Account, so the second restore retires
        // the first private Session. Publish both Homes' qualified facts through
        // the real listing/Machine owners before opening the inactive Home.
        fixture.storage.getState().applyServerScopedSessionListRows(fixture.scope.serverId, [createSessionListRenderableSessionFixture({
            ...fixture.session,
        })], { source: 'rowOnly', mode: 'replace' });
        fixture.storage.getState().applyMachines(selectedHomeMachines, true, {
            sourceServerId: fixture.scope.serverId, sourceAccountId: 'alice',
        });
        fixture.storage.getState().markMachineListSettled(fixture.scope.serverId);
        fixture.setSnapshot(fileViewSnapshot({ rootPath: fixture.scope.rootPath, entries: changedEntries }));
        fixture.storage.getState().setSessionRepositoryTreeExpandedPaths('s1', ['src']);
        const screen = await render(fixture.scope.serverId);
        await screen.pressByTestIdAsync('repository-tree-filter-changed');
        expect(screen.findByTestId(rowId('src/a.ts'))).toBeTruthy();
        expect(screen.findByTestId(rowId('other-home.ts'))).toBeNull();
    });

    it('publishes the create action and the project context line to the pane header, both stable', async () => {
        const { PaneHeaderSlotProvider, PaneHeaderSlotScope, usePublishedPaneHeaderContent } = await import('@/components/appShell/panes/paneHeaderSlot');
        const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');
        let content: ReturnType<typeof usePublishedPaneHeaderContent>;
        function Reader() { content = usePublishedPaneHeaderContent('files'); return null; }
        const body = <PaneHeaderSlotProvider><Reader /><PaneHeaderSlotScope slotKey="files">
            <SessionRepositoryTreeBrowserView sessionId="s1" serverId={fixture.scope.serverId} onOpenFile={() => {}} />
        </PaneHeaderSlotScope></PaneHeaderSlotProvider>;
        const screen = await fixture.render(body);
        const action = content!.action;
        const line = content!.line;
        expect(action).toBeTruthy();
        // The folder this Session works in, then how many files changed (the Git pane's vocabulary).
        expect(line?.segments[0]).toContain(`changed-browser-${fixtureIndex}`);
        expect(line?.segments.at(-1)).toBe('sessionGitPane.header.changed:{"count":"3"}');
        await screen.pressByTestIdAsync('repository-tree-filter-changed');
        expect(content!.action).toBe(action);
        expect(content!.line).toBe(line);
    });

    it('collapses the Session-owned expansion and keeps Size/date and Refresh in the View menu', async () => {
        const screen = await render();
        await screen.pressByTestIdAsync('repository-tree-view');
        await vi.waitFor(() => {
            for (const id of ['repository-tree-toggle-details', 'repository-tree-collapse-all', 'repository-tree-refresh']) {
                expect(screen.findByTestId(id)).toBeTruthy();
            }
        });
        await screen.pressByTestIdAsync('repository-tree-collapse-all');
        await vi.waitFor(() => expect(fixture.storage.getState().getSessionRepositoryTreeExpandedPaths('s1')).toEqual([]));
    });
});
