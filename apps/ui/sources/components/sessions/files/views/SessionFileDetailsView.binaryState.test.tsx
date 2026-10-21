import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from './sessionFilesViewTestkit';
import { createSessionFileNativeTransferBoundary } from '../sessionFileNativeTransferTestkit';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

installSessionFilesViewBoundaries({ confirmResult: true });
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
let transfer: ReturnType<typeof createSessionFileNativeTransferBoundary>;
const filePath = 'bin.dat';

// Load the real shared graph at collection, outside the File journey's operation budget.
await prepareSessionFilesViewTestkit();
beforeEach(async () => {
    standardCleanup();
    transfer = createSessionFileNativeTransferBoundary({ bytes: new Uint8Array([0, 1, 0, 2]), name: filePath });
    fixture = await createSessionFilesViewFixture({
        serverIdentityId: 'srv_binary_file_details',
        machineCarrierOrigin: transfer.origin,
        request: transfer.request,
        rpc: (request) => request.method === 'statFile'
            ? { success: true, exists: true, kind: 'file', sizeBytes: 4 }
            : request.method === 'scm.diff.file' ? { success: true, diff: '' } : transfer.rpc(request),
    });
    fixture.setSnapshot(fileViewSnapshot({ entries: [{
        path: filePath, kind: 'modified', includeStatus: 'unmodified', pendingStatus: 'modified',
        hasIncludedDelta: false, hasPendingDelta: true, previousPath: null,
        stats: { pendingAdded: 1, pendingRemoved: 1, includedAdded: 0, includedRemoved: 0, isBinary: true },
    }] }));
});
afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

/** The page's `⋯` (one item list, `fileMenus.ts`): what it offers and choosing one. */
function fileMenu(screen: { tree: { root: { findAll: (predicate: (node: any) => boolean) => any[] } } }) {
    return screen.tree.root.findAll((node: any) => node.props?.testID === 'file-details-header.menu' && Array.isArray(node.props?.items))[0];
}

describe('SessionFileDetailsView (binary)', () => {
    it('keeps the download action available when the workspace scope is available', async () => {
        // A dormant Session still has an exact, reachable Workspace owner.
        fixture.storage.getState().applySessions([{ ...fixture.session, active: false }]);
        const { SessionFileDetailsView } = await import('./SessionFileDetailsView');
        const { FilePageHeader } = await import('@/components/workspaces/files/file/FilePageHeader');
        const screen = await fixture.render(<SessionFileDetailsView serverId={fixture.home.id} sessionId="s1" scopeId="session:s1" filePath={filePath} />);
        await vi.waitFor(() => expect(screen.findByTestId('file-action-toolbar')).not.toBeNull());
        expect(screen.tree.root.findAllByType(FilePageHeader)).toHaveLength(1);
        expect(fileMenu(screen)?.props.items.map((item: { id: string }) => item.id)).toContain('download');
    });

    it('renders header actions even when file content is binary', async () => {
        const { SessionFileDetailsView } = await import('./SessionFileDetailsView');
        const { FilePageHeader } = await import('@/components/workspaces/files/file/FilePageHeader');
        const { FileViewerBody } = await import('@/components/workspaces/files/file/FileViewerBody');
        const screen = await fixture.render(<SessionFileDetailsView serverId={fixture.home.id} sessionId="s1" scopeId="session:s1" filePath={filePath} />);
        await vi.waitFor(() => expect(screen.findByTestId('file-action-toolbar')).not.toBeNull());
        const toolbar = screen.tree.root.findAllByType(FilePageHeader);
        expect(toolbar).toHaveLength(1);
        const items = fileMenu(screen)?.props.items.map((item: { id: string }) => item.id) ?? [];
        // A binary file has no wrap; Download stays on the page's one menu. (Discard is P5's comparison arm: it
        // appears once the Session's comparison is captured, which this fixture does not serve.)
        expect(items).not.toContain('wrap');
        expect(items).toContain('download');
        expect(screen.tree.root.findAllByType(FileViewerBody)).toHaveLength(1);
        expect(screen.tree.root.findByType(FileViewerBody).props.viewer.kind).toBe('binary');
        await act(async () => { await fileMenu(screen)?.props.onSelect('download'); });
        expect(fixture.requests).toEqual(expect.arrayContaining([expect.objectContaining({
            targetId: 'm1',
            method: getActionSpec('daemon.filesystem.download').bindings?.rpcMethod,
            payload: expect.objectContaining({ rootPath: '/workspace', path: '/workspace/' + filePath, asZip: false }),
        })]));
    });
});
