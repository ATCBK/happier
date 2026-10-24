import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from './sessionFilesViewTestkit';
import { createSessionFileNativeTransferBoundary } from '../sessionFileNativeTransferTestkit';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

installSessionFilesViewBoundaries({ confirmResult: true });
await prepareSessionFilesViewTestkit();
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
let transfer: ReturnType<typeof createSessionFileNativeTransferBoundary>;
const filePath = 'big.txt';

beforeEach(async () => {
    standardCleanup();
    transfer = createSessionFileNativeTransferBoundary({ bytes: new Uint8Array([65, 66, 67]), name: filePath });
    fixture = await createSessionFilesViewFixture({
        serverIdentityId: 'srv_preview_too_large',
        machineCarrierOrigin: 'http://127.0.0.1:48126',
        request: transfer.request,
        rpc: (request) => request.method === 'statFile'
            ? { success: true, exists: true, kind: 'file', sizeBytes: Number.MAX_SAFE_INTEGER }
            : request.method === 'scm.diff.file' ? { success: true, diff: '' } : transfer.rpc(request),
    });
    fixture.setSnapshot(fileViewSnapshot({ entries: [{
        path: filePath, kind: 'modified', includeStatus: 'unmodified', pendingStatus: 'modified',
        hasIncludedDelta: false, hasPendingDelta: true, previousPath: null,
        stats: { pendingAdded: 1, pendingRemoved: 1, includedAdded: 0, includedRemoved: 0, isBinary: false },
    }] }));
});
afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

/** The page's `⋯` (one item list, `fileMenus.ts`). */
function fileMenu(screen: { tree: { root: { findAll: (predicate: (node: any) => boolean) => any[] } } }) {
    return screen.tree.root.findAll((node: any) => node.props?.testID === 'file-details-header.menu' && Array.isArray(node.props?.items))[0];
}

describe('SessionFileDetailsView (preview too large)', () => {
    it('keeps the download action available when the workspace scope is available', async () => {
        // A dormant Session still has an exact, reachable Workspace owner.
        fixture.storage.getState().applySessions([{ ...fixture.session, active: false }]);
        const { SessionFileDetailsView } = await import('./SessionFileDetailsView');
        const { FilePageHeader } = await import('@/components/workspaces/files/file/FilePageHeader');
        const screen = await fixture.render(<SessionFileDetailsView serverId={fixture.home.id} sessionId="s1" scopeId="session:s1" filePath={filePath} />);
        expect(screen.tree.root.findAllByType(FilePageHeader)).toHaveLength(1);
        // Too large to preview is a state of the file, not an error: no warning banner, and Download stays on the page's menu.
        await vi.waitFor(() => expect(fileMenu(screen)?.props.items.map((item: { id: string }) => item.id)).toContain('download'));
        expect(screen.findHostByTestId('file-preview-unavailable-banner')).toBeNull();
    });

    it('renders a download action instead of a fatal error state', async () => {
        const { SessionFileDetailsView } = await import('./SessionFileDetailsView');
        const { FilePageHeader } = await import('@/components/workspaces/files/file/FilePageHeader');
        const { FileErrorState } = await import('@/components/workspaces/files/file/FileScreenState');
        const screen = await fixture.render(<SessionFileDetailsView serverId={fixture.home.id} sessionId="s1" scopeId="session:s1" filePath={filePath} />);
        const toolbar = screen.tree.root.findAllByType(FilePageHeader);
        expect(toolbar).toHaveLength(1);
        await vi.waitFor(() => expect(fileMenu(screen)?.props.items.map((item: { id: string }) => item.id)).toContain('download'));
        expect(screen.tree.root.findAllByType(FileErrorState)).toHaveLength(0);
        expect(fixture.requests.some((request) => request.method === 'statFile')).toBe(true);
        await act(async () => { await fileMenu(screen)?.props.onSelect('download'); });
        expect(fixture.requests).toEqual(expect.arrayContaining([expect.objectContaining({
            targetId: 'm1',
            method: getActionSpec('daemon.filesystem.download').bindings?.rpcMethod,
            payload: expect.objectContaining({ rootPath: '/workspace', path: '/workspace/' + filePath, asZip: false }),
        })]));
    });
});
