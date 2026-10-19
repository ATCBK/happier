import * as React from 'react';
import * as ReactNative from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, invokeTestInstanceHandler, pressTestInstanceAsync, renderHook, renderScreen } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { ArtifactQuotaExceededError } from '@/sync/api/artifacts/apiArtifacts';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getStorage } from '@/sync/domains/state/storage';
import { useArtifactStorageUsage } from './artifactActionsClient';
import { useArtifactOperations } from './useArtifactOperations';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { Modal } from '@/modal';
import { router } from 'expo-router';
import { ActionsSettingsV1Schema, ApprovalRequestSchema, ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import type { ReactTestInstance } from 'react-test-renderer';

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit');
    return createExpoRouterMock().module;
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit');
    return createModalModuleMock().module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit');
    return createTextModuleMock();
});

import { ArtifactsBrowser, ArtifactsBrowserScreen } from './ArtifactsBrowserScreen';
import { sealArtifactPrivateRevisionMetadata } from '@/sync/domains/artifacts/accountArtifactEnvelope';
import { ArtifactView } from './ArtifactView';
import { NavigationTitleChromeProvider } from '@/components/ui/layout/navigationTitleChrome';

const initialState = getStorage().getState();
let disposeHome: (() => Promise<void>) | undefined;
afterEach(async () => {
    await act(async () => {
        await disposeHome?.();
        disposeHome = undefined;
        retireActiveServerAccountScopeLifetime();
        invalidateAccountEncryptionModeCache();
        getStorage().setState(initialState, true);
    });
    vi.restoreAllMocks();
});

function MeterBrowser() {
    const usage = useArtifactStorageUsage();
    const artifacts = getStorage()((state) => state.artifacts);
    return <ArtifactsBrowser artifacts={Object.values(artifacts)} loaded loadFailed={false} onRetry={() => {}} usage={usage} />;
}

function RecoveryBrowser({ loadFailed, onRetry, artifacts = [] }: Readonly<{
    loadFailed: boolean; onRetry: () => void; artifacts?: readonly DecryptedArtifact[];
}>) {
    return <AppPaneProvider><ArtifactsBrowser artifacts={artifacts} loaded loadFailed={loadFailed} onRetry={onRetry} usage={null} /></AppPaneProvider>;
}

function artifactFixture(id: string, extra: Partial<Extract<DecryptedArtifact, { isDecrypted: true }>> = {}): DecryptedArtifact {
    return { id, title: 'Notes', isDecrypted: true, header: { title: 'Notes' }, headerVersion: 1,
        bodyVersion: 2, seq: 1, body: 'Notes', createdAt: 1, updatedAt: 1,
        access: 'owner', storageMode: 'plain', ...extra };
}

async function renderRows(artifacts: readonly DecryptedArtifact[]) {
    const screen = await renderScreen(<RecoveryBrowser artifacts={artifacts} loadFailed={false} onRetry={() => {}} />);
    await act(async () => { invokeTestInstanceHandler(screen.findHostByTestId('artifacts:collection:stage'), 'onLayout', {
        nativeEvent: { layout: { x: 0, y: 0, width: 1200, height: 800 } },
    }); });
    return screen;
}

function rowMenu(screen: Awaited<ReturnType<typeof renderRows>>, id: string): ReactTestInstance {
    // Drive the real Collection row-action contract; its menu presentation is shared across surfaces.
    const row = screen.findAll(node => node.props.testID === `artifacts:row:${id}`
        && Array.isArray(node.props.secondaryActions)).at(-1);
    expect(row).toBeDefined();
    return row!;
}

describe('Artifacts browser folders view', () => {
    it('shows the same library as one tree and keeps the row operations of the list', async () => {
        const document = artifactFixture('document');
        const board = artifactFixture('board', { title: 'Launch', header: { v: 1, kind: 'work-board.v1', title: 'Launch',
            pinnedInSessions: false, readsNeedsYou: false }, body: undefined, bodyVersion: undefined });
        const screen = await renderRows([document, board]);
        expect(screen.findByTestId('artifacts:folders:row:artifact:document')).toBeNull();
        await screen.pressByTestIdAsync('artifacts:view:folders');
        expect(screen.findByTestId('artifacts:folders:row:artifact:document')).not.toBeNull();
        expect(screen.findByTestId('artifacts:folders:row:artifact:board')).not.toBeNull();
        // The Collection's cards and rows are replaced, never drawn beside the tree.
        expect(screen.findAll(node => node.props.testID === 'artifacts:row:document' && Array.isArray(node.props.secondaryActions))).toHaveLength(0);
        const menu = screen.findAll(node => node.props.testID === 'artifacts:folders:menu:artifact:board' && typeof node.props.onSelect === 'function').at(0);
        expect(menu?.props.items.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining(['open', 'history']));
        // Opening a kind with its own destination leaves the browser for it.
        vi.mocked(router.push).mockClear();
        await act(async () => { menu?.props.onSelect('open'); });
        expect(router.push).toHaveBeenCalledTimes(1);
        // Without an admitted folder catalog nothing can be filed: no New folder, no Move.
        expect(screen.findByTestId('artifacts:folders:new')?.props.disabled).toBe(true);
        expect(menu?.props.items.some((item: { id: string }) => item.id === 'move')).toBe(false);
    });
});

describe('Artifacts browser row operations', () => {
    it.each(['work-board.v1', 'prompt_doc.v2'])('opens Share from a cold owner %s row without opening its body', async kind => {
        const served = await serveActionHomes({
            homes: [{ key: 'owner', serverUrl: 'https://artifact-cold-share.test', accountId: 'owner' }],
            route: () => undefined,
        });
        disposeHome = served.dispose;
        const artifact = artifactFixture('cold-document', { header: { v: 1, kind, title: 'Cold document',
            ...(kind === 'work-board.v1' ? { pinnedInSessions: false, readsNeedsYou: false } : {}) },
            body: undefined, bodyVersion: undefined });
        const screen = await renderRows([artifact]);
        const menu = rowMenu(screen, artifact.id);
        expect(menu.props.secondaryActions.map((item: { id: string }) => item.id)).toContain('share');
        await act(async () => { invokeTestInstanceHandler(menu, 'onSecondaryAction', 'share'); });
        expect(Modal.show).toHaveBeenLastCalledWith(expect.objectContaining({
            props: expect.objectContaining({ artifactId: artifact.id, kind }),
            chrome: expect.objectContaining({ testID: 'document-share-modal' }),
        }));
        expect(served.requests.filter(request => request.path.startsWith('/v1/artifacts/'))).toEqual([]);
    });

    it.each([
        { access: undefined, kind: 'markdown' },
        { access: 'view' as const, kind: 'prompt_doc.v2' },
        { access: 'edit' as const, kind: 'work-board.v1' },
        { access: 'owner' as const, kind: 'home-hub-layout.v1' },
        { access: 'owner' as const, kind: 'approval_request.v1' },
    ])('does not offer Share without positive managing access or when the kind denies it (%j)', async ({ access, kind }) => {
        const artifact = artifactFixture('denied', { access, header: { kind, title: 'Denied' }, body: undefined });
        const hook = await renderHook(() => useArtifactOperations(artifact, () => {}));
        expect(hook.getCurrent().canShare).toBe(false);
        vi.mocked(Modal.show).mockClear();
        await act(async () => { hook.getCurrent().share(); });
        expect(Modal.show).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('opens the shared Share and History owners and confirms revision-qualified deletion', async () => {
        const artifact = artifactFixture('document');
        const served = await serveActionHomes({ homes: [{ key: 'owner', serverUrl: 'https://artifact-row.test', accountId: 'owner' }],
            route: request => {
                // Generic mutations admit the actual current document through artifact.get first.
                if (request.path === '/v1/artifacts/document' && request.method === 'GET')
                    return Response.json({ ...artifact, ownerAccountId: 'owner', encryptionMode: 'plain',
                        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                        header: encodePlainArtifactStoredContent(artifact.header),
                        body: encodePlainArtifactStoredContent({ body: artifact.body }) });
                if (request.path === '/v1/artifacts/document/revision/1/2' && request.method === 'DELETE')
                    return Response.json({ success: true });
                return undefined;
            } });
        disposeHome = served.dispose;
        getStorage().getState().addArtifact(artifact);
        getStorage().setState(state => ({ localSettings: { ...state.localSettings, uiMultiPanePanelsEnabled: false } }));
        const screen = await renderRows([artifact]);
        const menu = rowMenu(screen, artifact.id);
        expect(menu.props.secondaryActions.map((item: { id: string }) => item.id)).toEqual(['open', 'share', 'history', 'delete']);
        await act(async () => { invokeTestInstanceHandler(menu, 'onSecondaryAction', 'open'); });
        expect(router.push).toHaveBeenLastCalledWith('/artifacts/document');
        await act(async () => { invokeTestInstanceHandler(menu, 'onSecondaryAction', 'share'); });
        expect(Modal.show).toHaveBeenLastCalledWith(expect.objectContaining({ props: expect.objectContaining({ artifactId: artifact.id }),
            chrome: expect.objectContaining({ testID: 'document-share-modal' }) }));
        await act(async () => { invokeTestInstanceHandler(menu, 'onSecondaryAction', 'history'); });
        expect(Modal.show).toHaveBeenLastCalledWith(expect.objectContaining({ props: { artifactId: artifact.id, canRestore: true },
            chrome: expect.objectContaining({ testID: 'artifact-history-modal' }) }));
        await act(async () => { await menu.props.onSecondaryAction('delete'); });
        expect(served.requests.filter(request => request.method === 'DELETE')).toEqual([]);
        expect(getStorage().getState().artifacts[artifact.id]).toBeDefined();
        vi.mocked(Modal.confirm).mockClear().mockResolvedValue(true);
        await act(async () => { await menu.props.onSecondaryAction('delete'); });
        await flushHookEffects();
        expect(Modal.confirm).toHaveBeenCalledTimes(1);
        expect(served.requests.find(request => request.method === 'DELETE')?.path)
            .toBe('/v1/artifacts/document/revision/1/2');
        expect(getStorage().getState().artifacts[artifact.id]).toBeUndefined();
    });

    it('opens a shared Workflow in its destination and keeps mutation operations unavailable', async () => {
        const artifact = artifactFixture('workflow-1', { access: 'view', header: { kind: 'workflow-definition.v1', title: 'Review' } });
        const screen = await renderRows([artifact]);
        const menu = rowMenu(screen, artifact.id);
        expect(menu.props.secondaryActions.map((item: { id: string }) => item.id)).toEqual(['open', 'history']);
        await act(async () => { invokeTestInstanceHandler(menu, 'onSecondaryAction', 'open'); });
        expect(router.push).toHaveBeenLastCalledWith('/workflows/workflow-1');
        await act(async () => { invokeTestInstanceHandler(menu, 'onSecondaryAction', 'history'); });
        expect(Modal.show).toHaveBeenLastCalledWith(expect.objectContaining({ props: { artifactId: artifact.id, canRestore: false } }));
    });

    it('allows a shared editor to restore history without managing shares or deleting', async () => {
        const artifact = artifactFixture('editable', { access: 'edit' });
        const screen = await renderRows([artifact]);
        const menu = rowMenu(screen, artifact.id);
        expect(menu.props.secondaryActions.map((item: { id: string }) => item.id)).toEqual(['open', 'history']);
        await act(async () => { invokeTestInstanceHandler(menu, 'onSecondaryAction', 'history'); });
        expect(Modal.show).toHaveBeenLastCalledWith(expect.objectContaining({ props: { artifactId: artifact.id, canRestore: true } }));
    });

    it('opens a policy-required delete approval without claiming or executing deletion', async () => {
        const artifact = artifactFixture('approval-document');
        const persisted = createArtifactStoreBoundary({ ownerAccountId: () => 'owner', encryptionMode: 'plain' });
        // The full inventory and exact read must describe the same persisted document.
        persisted.replaceStoredRow({ id: artifact.id, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, header: encodePlainArtifactStoredContent(artifact.header),
            body: encodePlainArtifactStoredContent({ body: artifact.body }), headerVersion: artifact.headerVersion,
            bodyVersion: artifact.bodyVersion, seq: artifact.seq, createdAt: artifact.createdAt, updatedAt: artifact.updatedAt });
        const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1, actions: {
            'artifact.delete': { approvalRequiredSurfaces: ['ui'] },
        } });
        const served = await serveActionHomes({ homes: [{ key: 'owner', serverUrl: 'https://artifact-row-approval.test',
            accountId: 'owner', settings: { actionsSettingsV1 } }],
            route: request => persisted.handle(request.path, { method: request.method, body: JSON.stringify(request.body) }) ?? undefined });
        disposeHome = served.dispose;
        getStorage().getState().addArtifact(artifact);
        const screen = await renderRows([artifact]);
        vi.mocked(Modal.confirm).mockClear().mockResolvedValueOnce(true);
        await act(async () => { await rowMenu(screen, artifact.id).props.onSecondaryAction('delete'); });
        expect(Modal.confirm).toHaveBeenCalledTimes(1);
        const approval = persisted.list().find(row => row.id !== artifact.id);
        expect(approval).toBeDefined();
        expect(ApprovalRequestSchema.parse(JSON.parse(persisted.readPlainBody(approval!.id)!)))
            .toMatchObject({ actionId: 'artifact.delete', status: 'open' });
        expect(served.requests.filter(request => request.method === 'DELETE')).toEqual([]);
        expect(getStorage().getState().artifacts[artifact.id]).toBeDefined();
        expect(router.push).toHaveBeenLastCalledWith(`/inbox/approvals/${encodeURIComponent(approval!.id)}?serverId=${encodeURIComponent(served.homes.owner!.id)}`);
    });

});

describe('Artifacts browser recovery', () => {
    it('demands attribution while mounted, refreshes newer background revisions and releases the read on unmount', async () => {
        const id = '11111111-1111-4111-8111-111111111111';
        const persisted = createArtifactStoreBoundary({ ownerAccountId: () => 'owner', encryptionMode: 'plain' });
        const version = async (revision: number) => ({ id, ownerAccountId: 'owner', access: 'owner' as const,
            encryptionMode: 'plain' as const, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ title: 'Attributed document', kind: 'markdown' }),
            body: encodePlainArtifactStoredContent({ body: 'Unopened content' }), headerVersion: revision, bodyVersion: revision,
            provenance: await sealArtifactPrivateRevisionMetadata({ mode: 'plain', artifactId: id, bodyVersion: revision,
                provenance: { savedBy: { kind: 'agent', accountId: 'owner', sessionId: `author-${revision}` } } }),
            seq: revision, createdAt: 1, updatedAt: revision });
        persisted.replaceStoredRow(await version(1));
        const served = await serveActionHomes({ homes: [{ key: 'owner', serverUrl: 'https://artifact-demand.test', accountId: 'owner' }],
            route: request => persisted.handle(request.path + request.url.search, { method: request.method,
                headers: request.headers, body: request.method === 'GET' ? undefined : JSON.stringify(request.body) }) ?? undefined });
        disposeHome = served.dispose;
        const disconnect = await served.restoreActiveConnection();
        const { sync } = await import('@/sync/sync');
        try {
            await sync.fetchArtifactsList();
            expect(getStorage().getState().artifacts[id]?.provenance).toBeUndefined();
            const screen = await renderScreen(<AppPaneProvider><ArtifactsBrowserScreen /></AppPaneProvider>);
            try {
                await vi.waitFor(() => expect(getStorage().getState().artifacts[id]?.provenance?.savedBy)
                    .toMatchObject({ sessionId: 'author-1' }));
                persisted.replaceStoredRow(await version(2));
                await act(async () => { await sync.fetchArtifactsList(); });
                expect(getStorage().getState().artifacts[id]?.provenance?.savedBy).toMatchObject({ sessionId: 'author-2' });
            } finally { await screen.unmount(); }
            persisted.replaceStoredRow(await version(3));
            await sync.fetchArtifactsList();
            expect(getStorage().getState().artifacts[id]).toMatchObject({ bodyVersion: 3 });
            expect(getStorage().getState().artifacts[id]?.provenance).toBeUndefined();
            expect(served.requests.some(request => request.path === '/v1/artifacts/read')).toBe(false);
        } finally { await disconnect(); }
    });
    it.each(['phone', 'panes-disabled'] as const)('retains selected details on %s and routes fresh opens', async transition => {
        const dimensions = vi.spyOn(ReactNative, 'useWindowDimensions')
            .mockReturnValue({ width: 1440, height: 1000, scale: 1, fontScale: 1 });
        getStorage().setState(state => ({ localSettings: { ...state.localSettings, uiMultiPanePanelsEnabled: true } }));
        const artifacts = [artifactFixture('retained-view'), artifactFixture('fresh-view')];
        const element = () => <AppPaneProvider><ArtifactsBrowser artifacts={artifacts} initialOpenId="retained-view"
            loaded loadFailed={false} onRetry={() => {}} usage={null} /></AppPaneProvider>;
        const screen = await renderScreen(element());
        const viewer = screen.root.findByType(ArtifactView);
        if (transition === 'phone') dimensions.mockReturnValue({ width: 390, height: 844, scale: 1, fontScale: 1 });
        else await act(async () => getStorage().setState(state => ({ localSettings: { ...state.localSettings, uiMultiPanePanelsEnabled: false } })));
        await screen.update(element());
        expect(screen.root.findAllByType(ArtifactView)).toEqual([viewer]);
        expect(viewer.props.artifactId).toBe('retained-view');
        // A new selection still follows the phone/disabled-pane route contract.
        await act(async () => { invokeTestInstanceHandler(screen.findHostByTestId('artifacts:collection:stage'), 'onLayout', {
            nativeEvent: { layout: { x: 0, y: 0, width: 1200, height: 800 } },
        }); });
        await act(async () => { invokeTestInstanceHandler(rowMenu(screen, 'fresh-view'), 'onSecondaryAction', 'open'); });
        expect(router.push).toHaveBeenLastCalledWith('/artifacts/fresh-view');
        expect(screen.root.findAllByType(ArtifactView)).toEqual([viewer]);
        dimensions.mockReturnValue({ width: 1440, height: 1000, scale: 1, fontScale: 1 });
        await act(async () => getStorage().setState(state => ({ localSettings: { ...state.localSettings, uiMultiPanePanelsEnabled: true } })));
        await screen.update(element());
        expect(screen.root.findAllByType(ArtifactView)).toEqual([viewer]);
    });

    it('names a code document by its language, as its own page does, rather than as a plain document', async () => {
        const screen = await renderRows([artifactFixture('code-1', { title: 'relayHandshake.ts', header: { title: 'relayHandshake.ts' }, body: 'export const retries = 5;' })]);
        expect(screen.findAll(node => node.props.accessibilityLabel === 'relayHandshake.ts, TypeScript').length).toBeGreaterThan(0);
    });

    it('shows wide list headings for the actual anatomy and retains row operations when narrowed', async () => {
        const screen = await renderRows([artifactFixture('document')]);
        await screen.pressByTestIdAsync('artifacts:view:list');
        expect(screen.getTextContent()).toContain('artifacts.browser.kindLabel');
        expect(screen.getTextContent()).toContain('artifacts.browser.sourceLabel');
        await act(async () => { invokeTestInstanceHandler(screen.findHostByTestId('artifacts:collection:stage'), 'onLayout', {
            nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 800 } },
        }); });
        expect(rowMenu(screen, 'document').props.secondaryActions.map((item: { id: string }) => item.id))
            .toEqual(['open', 'share', 'history', 'delete']);
    });

    it('keeps phone search, choices and count while omitting the redundant introduction', async () => {
        vi.spyOn(ReactNative, 'useWindowDimensions').mockReturnValue({ width: 390, height: 844, scale: 1, fontScale: 1 });
        const screen = await renderRows([artifactFixture('document')]);
        expect(screen.getTextContent()).not.toContain('artifacts.browser.description');
        expect(screen.findByTestId('artifacts:search')).not.toBeNull();
        expect(screen.findByTestId('artifacts:kind')).not.toBeNull();
        expect(screen.findByTestId('artifacts:present')).not.toBeNull();
    });

    it('draws the phone Folders toolbar as one compact row: kind · icon-only New folder · view (lab c-art Tp)', async () => {
        vi.spyOn(ReactNative, 'useWindowDimensions').mockReturnValue({ width: 390, height: 844, scale: 1, fontScale: 1 });
        const screen = await renderRows([artifactFixture('document')]);
        await screen.pressByTestIdAsync('artifacts:view:folders');
        expect(screen.findByTestId('artifacts:kind')).not.toBeNull();
        expect(screen.findByTestId('artifacts:sort')).toBeNull();
        const newFolder = screen.findByTestId('artifacts:folders:new');
        expect(newFolder).not.toBeNull();
        // The glyph alone, named for assistive technology; no visible label beside it.
        expect(newFolder?.props.accessibilityLabel).toBe('artifacts.browser.folders.newFolder');
        expect(newFolder?.props.title).toBeUndefined();
    });

    it('keeps the page identity visible beneath phone navigation chrome', async () => {
        const screen = await renderScreen(<NavigationTitleChromeProvider showsTitle>
            <RecoveryBrowser loadFailed={false} onRetry={() => {}} />
        </NavigationTitleChromeProvider>);
        const heading = screen.findAll(node => typeof node.type === 'string'
            && node.props.accessibilityRole === 'header'
            && node.children.includes('artifacts.title'));
        expect(heading).toHaveLength(1);
    });
    it('replaces an already-loaded empty welcome with failure and a working Retry', async () => {
        const retry = vi.fn();
        const screen = await renderScreen(<RecoveryBrowser loadFailed={false} onRetry={retry} />);
        expect(screen.findHostByTestId('artifacts:empty')).not.toBeNull();

        await screen.update(<RecoveryBrowser loadFailed onRetry={retry} />);
        expect(screen.findHostByTestId('artifacts:empty')).toBeNull();
        expect(screen.findHostByTestId('artifacts:failed')).not.toBeNull();
        const retryButton = screen.findAll((node) => typeof node.type === 'string'
            && node.props.accessibilityRole === 'button' && node.props.accessibilityLabel === 'common.retry').at(-1);
        expect(retryButton).toBeDefined();
        await pressTestInstanceAsync(retryButton, 'Retry');
        expect(retry).toHaveBeenCalledOnce();

        await screen.update(<RecoveryBrowser loadFailed={false} onRetry={retry} />);
        expect(screen.findHostByTestId('artifacts:failed')).toBeNull();
        expect(screen.findHostByTestId('artifacts:empty')).not.toBeNull();
    });

    it('keeps hydrated documents visible when a later refresh fails', async () => {
        const artifact: DecryptedArtifact = { id: 'retained', title: 'Notes', isDecrypted: true,
            header: { title: 'Notes' }, headerVersion: 1, bodyVersion: 1, seq: 1,
            body: 'Notes', createdAt: 1, updatedAt: 1, access: 'owner', storageMode: 'plain' };
        const retry = vi.fn();
        const screen = await renderScreen(<RecoveryBrowser artifacts={[artifact]} loadFailed={false} onRetry={retry} />);
        await act(async () => {
            invokeTestInstanceHandler(screen.findHostByTestId('artifacts:collection:stage'), 'onLayout', {
                nativeEvent: { layout: { x: 0, y: 0, width: 1200, height: 800 } },
            });
        });
        expect(screen.findHostByTestId('artifacts:row:retained')).not.toBeNull();
        await screen.update(<RecoveryBrowser artifacts={[artifact]} loadFailed onRetry={retry} />);
        expect(screen.findHostByTestId('artifacts:row:retained')).not.toBeNull();
        expect(screen.findHostByTestId('artifacts:empty')).toBeNull();
        expect(screen.findHostByTestId('artifacts:failed')).toBeNull();
        expect(screen.findHostByTestId('artifacts:stale')).not.toBeNull();
        await screen.pressByTestIdAsync('artifacts:stale-action');
        expect(retry).toHaveBeenCalledOnce();
        await screen.update(<RecoveryBrowser artifacts={[artifact]} loadFailed={false} onRetry={retry} />);
        expect(screen.findHostByTestId('artifacts:stale')).toBeNull();
        expect(screen.findHostByTestId('artifacts:row:retained')).not.toBeNull();
    });

    it('clears the full-budget banner after quota refusal then deletion without remounting', async () => {
        let usedBytes = 1000;
        const served = await serveActionHomes({
            homes: [{ key: 'owner', serverUrl: 'https://artifact-browser-quota.test', accountId: 'owner' }],
            route: (request) => {
                if (request.path === '/v1/artifacts/storage/usage')
                    return Response.json({ usedBytes, limitBytes: 1000, documentLimitBytes: null, revisionRetentionCount: 10 });
                if (request.path === '/v1/artifacts' && request.method === 'POST')
                    return Response.json({ error: 'quota_exceeded', budget: 'account', limitBytes: 1000, usedBytes }, { status: 413 });
                if (request.path === '/v1/artifacts/document' && request.method === 'DELETE') {
                    usedBytes = 100;
                    return Response.json({ success: true });
                }
                return undefined;
            },
        });
        disposeHome = served.dispose;
        const artifact: DecryptedArtifact = { id: 'document', title: 'Notes', isDecrypted: true,
            header: { title: 'Notes' }, headerVersion: 1, bodyVersion: 1, seq: 1,
            body: 'Notes', createdAt: 1, updatedAt: 1, access: 'owner', storageMode: 'plain' };
        getStorage().getState().addArtifact(artifact);
        getStorage().getState().addArtifact({ ...artifact, id: 'retained' });
        const screen = await renderScreen(<AppPaneProvider><MeterBrowser /></AppPaneProvider>);
        await flushHookEffects();
        expect(screen.findHostByTestId('artifacts:quota')).not.toBeNull();
        expect(screen.findHostByTestId('artifacts:storageMeter')?.props.accessibilityValue.now).toBe(100);

        const account = await captureLazyActionAccountContext(served.homes.owner!.id);
        try {
            await expect(account.workflowArtifacts.create({ artifactId: 'another', header: { title: 'Another document' }, body: 'Content' }))
                .rejects.toBeInstanceOf(ArtifactQuotaExceededError);
            await act(async () => { expect(await account.workflowArtifacts.delete(artifact.id)).toEqual({ ok: true }); });
            await flushHookEffects();
            expect(getStorage().getState().artifacts[artifact.id]).toBeUndefined();
            expect(screen.findHostByTestId('artifacts:quota')).toBeNull();
            expect(screen.findHostByTestId('artifacts:storageMeter')?.props.accessibilityValue.now).toBe(10);
        } finally { account.dispose(); }
    });
});
