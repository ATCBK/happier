/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, buildWorkBoardArtifactHeaderV1, createWorkBoardV1, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { installBrowserStorageLockBoundary } from '@/dev/testkit/harness/browserStorageLockBoundary';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { BoardScreen } from './BoardScreen';

vi.mock('react-native', async () => ({
    ...await vi.importActual<typeof import('react-native-web')>('react-native-web'),
    useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
}));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/boards/qa43-board' }).module);

// The Account fixture's real readiness graph belongs to collection, not a UI interaction deadline.
await import('@/sync/syncEngine');
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let home: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
let restoreBrowserLocks: ReturnType<typeof installBrowserStorageLockBoundary>;
beforeEach(() => { restoreBrowserLocks = installBrowserStorageLockBoundary(); });
afterEach(async () => {
    try { await standardCleanup(); await home?.dispose(); }
    finally { home = undefined; restoreBrowserLocks(); }
});

describe('Board phone Add entry points', () => {
    it('opens one Add surface from the empty CTA and again from the navigation overflow', async () => {
        // This fixture admits an Account directly instead of starting unrelated cold Sync
        // acquisitions. All Board reads, codecs, navigation and overlay owners remain real.
        home = await createPlainArtifactHomeFixture('https://board-phone.test', { accountId: 'owner' });
        const board = createWorkBoardV1({ id: 'qa43-board', name: 'QA43 Board' });
        home.boundary.replaceStoredRow({
            id: board.id, header: encodePlainArtifactStoredContent(buildWorkBoardArtifactHeaderV1(board)),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(board) }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1,
            seq: 1, createdAt: 1, updatedAt: 1, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
        });
        const credentials = await TokenStorage.getCredentialsForServerUrl(home.home.serverUrl);
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        const find = (testID: string) => document.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
        const expectReady = (testID: string, present = true) => waitForHomeGovernance(async () => {
            await act(async () => {});
            if (present) expect(find(testID), document.body.textContent).not.toBeNull();
            else expect(find(testID), document.body.textContent).toBeNull();
        });
        const press = async (testID: string) => { await act(async () => { find(testID)!.click(); }); };
        try {
        await act(async () => root.render(<InjectedAuthProvider credentials={credentials}>
            <DestinationInstanceHost tabId="board" ref={{ kind: 'boards', params: { id: board.id } }}
                pathname={`/boards/${board.id}`} focused visible phone
                navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
                <BoardScreen boardId={board.id} />
            </DestinationInstanceHost>
        </InjectedAuthProvider>));
        await expectReady('board-empty');
        // The empty state says the board is empty; the header meta does not say it again.
        expect(find('board-header')?.textContent ?? '').not.toMatch(/Nothing here yet|addedByHandNone/);
        expect(find('board-header.source')).not.toBeNull();
        expect(find('board-header.add')).toBeNull();
        await press('board-empty.add');
        await expectReady('board-add.popover');
        expect(document.querySelectorAll('[data-testid="board-add.popover"]')).toHaveLength(1);
        await press('popover-sheet.close');
        await expectReady('board-add.popover', false);
        await press('page-header-actions.trigger');
        await expectReady('board-header.add');
        await press('board-header.add');
        await expectReady('board-add.popover');
        expect(document.querySelectorAll('[data-testid="board-add.popover"]')).toHaveLength(1);
        } finally {
            await act(async () => root.unmount());
            container.remove();
        }
    });
});
