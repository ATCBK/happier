import * as React from 'react';
import { Platform } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { createDeferred, flushHookEffects, renderScreen } from '@/dev/testkit';
import { serveActionHomes, type ServedHomeRequest } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { getStorage } from '@/sync/domains/state/storage';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { setServerReachabilityNetworkAllowed } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { encodeBase64 } from '@/encryption/base64';
import { hashArtifactBinaryContent } from '@/sync/domains/artifacts/artifactBinaryContent';
import type { Encryption } from '@/sync/encryption/encryption';
import type { Artifact, DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { decryptArtifactWithBody } from '@/sync/engine/artifacts/syncArtifacts';
import { sync } from '@/sync/sync';

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
import { ArtifactView } from './ArtifactView';

const initialState = getStorage().getState();
const platform = Platform.OS;
let disposeHome: (() => Promise<void>) | undefined;
afterEach(async () => {
    await act(async () => {
        await disposeHome?.();
        disposeHome = undefined;
        retireActiveServerAccountScopeLifetime();
        getStorage().setState(initialState, true);
    });
    Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
    vi.restoreAllMocks();
});

function OpenView({ id }: Readonly<{ id: string }>) {
    const artifact = getStorage()(state => state.artifacts[id] ?? null);
    return <ArtifactView artifactId={id} artifact={artifact} presentation="page" />;
}

// The shared image preview cache is process-wide and keyed by content, so every setup serves
// distinct bytes: each test then starts from a cold preview rather than a cache hit.
let setupSequence = 0;

async function setup(kind: 'image' | 'html' | 'file', delayBlob?: Promise<Response>, warm = false,
    override?: (request: ServedHomeRequest) => Response | Promise<Response> | undefined) {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    const bytes = new TextEncoder().encode(kind === 'html' ? '<!doctype html><h1>Saved HTML</h1>' : `Private bytes ${++setupSequence}`);
    const reference = { blobId: 'e704b26f-9c31-4728-9590-858378e34ed9', mime: kind === 'html' ? 'text/html' : kind === 'image' ? 'image/png' : 'application/zip',
        sizeBytes: bytes.length, sha256: hashArtifactBinaryContent(bytes) };
    const row: DecryptedArtifact = { id: 'document', title: 'Saved', header: { kind: kind === 'html' ? 'html' : 'artifact.legacy', title: 'Saved' },
        isDecrypted: true, body: warm ? reference : undefined, storageMode: 'plain', ownerAccountId: 'owner', access: 'owner',
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    const head: Artifact = { id: row.id, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
        header: encodePlainArtifactStoredContent(row.header), body: encodePlainArtifactStoredContent({ body: reference }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER };
    const served = await serveActionHomes({ homes: [{ key: 'owner', serverUrl: 'https://view.test', accountId: 'owner' }], route: request => {
        const overridden = override?.(request);
        if (overridden !== undefined) return overridden;
        if (request.path === '/v1/artifacts/document') return Response.json(head);
        if (request.path.includes('/blobs/')) return delayBlob ?? Response.json({ blobId: reference.blobId, content: { t: 'plain', v: encodeBase64(bytes) } });
        if (request.path.endsWith('/html-preview')) return Response.json({ url: 'https://document.preview.test/a/document' });
    } });
    disposeHome = served.dispose;
    await loadSyncSingletonForTests();
    // This Node renderer has no browser sessionStorage for a tab-scoped selection.
    await upsertAndActivateServer({ serverUrl: served.homes.owner!.serverUrl, scope: 'device' });
    expect(getActiveServerSnapshot().serverUrl).toBe(served.homes.owner!.serverUrl);
    // Seed the real singleton's authenticated state; no sync or crypto behavior is substituted.
    const initialized = sync as unknown as { credentials: AuthCredentials | null; encryption: Encryption | null };
    initialized.credentials = await TokenStorage.getCredentialsForServerUrl(served.homes.owner!.serverUrl);
    initialized.encryption = null;
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    setServerReachabilityNetworkAllowed(true);
    const storedRow = warm ? await decryptArtifactWithBody({ artifact: head, encryption: null, artifactDataKeys: new Map() }) : row;
    if (!storedRow) throw new Error('Missing warm Artifact');
    getStorage().getState().addArtifact(storedRow);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:private-preview');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    return { served, head, row, bytes, reference };
}

describe('Artifact composed view reads', () => {
    it('displays a workspace copy without fabricating a Session destination', async () => {
        const row: DecryptedArtifact = { id: 'workspace-copy', title: 'Copied note', isDecrypted: true,
            header: { kind: 'published.v1', title: 'Copied note' }, body: 'Frozen workspace bytes',
            ownerAccountId: 'owner', access: 'owner', storageMode: 'plain',
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
            provenance: { savedBy: { kind: 'person', accountId: 'owner' }, source: {
                machineId: 'machine', rootPath: '/repo', path: 'docs/note.txt', sha: 'a'.repeat(64),
            } } };
        const screen = await renderScreen(<ArtifactView artifactId={row.id} artifact={row} presentation="page" />);
        expect(screen.findByTestId('artifact:provenance')).not.toBeNull();
        expect(screen.findByTestId('artifact:provenance:open')).toBeNull();
        await screen.unmount();
    });
    it.each(['pane', 'page'] as const)('never mounts cached approval custody as a Document in the %s', async presentation => {
        const row: DecryptedArtifact = { id: 'approval', title: 'Review request', isDecrypted: true,
            header: { kind: 'approval_request.v1', title: 'Review request', serverIdentityId: 'home' },
            body: 'retained request envelope', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        const screen = await renderScreen(<ArtifactView artifactId={row.id} artifact={row} presentation={presentation} />);
        // Keep even a failing privacy assertion from dumping the renderer's custody tree.
        expect(screen.findByTestId('artifact:body') !== null).toBe(false);
        expect(screen.findByTestId('artifact:actions') !== null).toBe(false);
        expect(screen.tree.root.findByType('Redirect').props.href).toBe('/inbox?item=approval%3Ahome%3Aapproval');
        await screen.unmount();
    });
    it('shows a saved widget as the widget itself, never its stored definition as a document', async () => {
        const definition = { v: 1, id: 'saved-widget', name: 'Tokens per day', sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' } };
        const row: DecryptedArtifact = { id: 'saved-widget', title: 'Tokens per day', isDecrypted: true,
            header: { kind: 'widget-definition.v1', v: 1, title: 'Tokens per day' },
            body: JSON.stringify(definition), ownerAccountId: 'owner', access: 'owner', storageMode: 'plain',
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        const screen = await renderScreen(<ArtifactView artifactId={row.id} artifact={row} presentation="page" />);
        expect(screen.findByTestId('artifact:widget')).not.toBeNull();
        expect(screen.findByTestId('artifact:body') === null).toBe(true);
        // It is a widget, not a text document: named so, and never offered to the text editor.
        expect(screen.tree.root.findByProps({ testID: 'artifact:header' }).props.meta[0]).toMatchObject({ key: 'kind', text: 'artifacts.browser.kindOne.widget' });
        expect(screen.findByTestId('artifact:edit') === null).toBe(true);
        expect(screen.findByTestId('artifact:history') !== null).toBe(true);
        await screen.unmount();
    });
    it.each([{ kind: 'image', warm: false }, { kind: 'html', warm: false }, { kind: 'image', warm: true }, { kind: 'html', warm: true }] as const)(
        'opens $kind (warm=$warm) through one authenticated head and renders its private preview', async ({ kind, warm }) => {
        const { served } = await setup(kind, undefined, warm);
        const screen = await renderScreen(<OpenView id="document" />);
        await vi.waitFor(() => expect(kind === 'image' ? screen.findByTestId('artifact:viewerBody') : screen.findByTestId('artifact:htmlPreview')).not.toBeNull());
        const heads = served.requests.filter(request => request.path === '/v1/artifacts/document');
        console.info('Artifact view measurement', { kind, warm, heads: heads.length,
            blobs: served.requests.filter(request => request.path.includes('/blobs/')).length,
            shells: served.requests.filter(request => request.path.endsWith('/html-preview')).length });
        expect(heads).toHaveLength(1);
        // Public feature discovery may be anonymous; every private Artifact operation must authenticate.
        const privateRequests = served.requests.filter(request => request.path === '/v1/artifacts' || request.path.startsWith('/v1/artifacts/'));
        expect(privateRequests.every(request => request.accountId === 'owner')).toBe(true);
        await screen.unmount();
    });

    it('leaves a generic file download deferred and suppresses the retired preview while renewed authority reads again', async () => {
        const { served } = await setup('file');
        const file = await renderScreen(<OpenView id="document" />);
        await flushHookEffects();
        await vi.waitFor(() => expect(file.findByTestId('artifact:download')).not.toBeNull());
        expect(served.requests.some(request => request.path.includes('/blobs/'))).toBe(false);
        await file.unmount();
        await disposeHome?.();
        const pending = createDeferred<Response>();
        const renewed = createDeferred<Response>();
        let blobReads = 0;
        const next = await setup('image', undefined, false, request => request.path.includes('/blobs/')
            ? ++blobReads === 1 ? pending.promise : renewed.promise : undefined);
        const image = await renderScreen(<OpenView id="document" />);
        const response = () => Response.json({ blobId: next.reference.blobId, content: { t: 'plain', v: encodeBase64(next.bytes) } });
        try {
            await vi.waitFor(() => expect(blobReads).toBe(1));
            await act(async () => { retireActiveServerAccountScopeLifetime(); });
            await vi.waitFor(() => expect(blobReads).toBe(2));
            await act(async () => { pending.resolve(response()); });
            await flushHookEffects();
            expect(image.findByTestId('artifact:viewerBody') === null).toBe(true);
            expect(URL.createObjectURL).not.toHaveBeenCalled();
            await act(async () => { renewed.resolve(response()); });
            await vi.waitFor(() => expect(image.findByTestId('artifact:viewerBody')).not.toBeNull());
        } finally {
            pending.resolve(response());
            renewed.resolve(response());
            await image.unmount();
        }
    });

    it('reopens an HTML frame retry through fresh Account authority without repeating a head within either operation', async () => {
        const { served } = await setup('html');
        const screen = await renderScreen(<OpenView id="document" />);
        await vi.waitFor(() => expect(screen.findByTestId('artifact:htmlPreview')).not.toBeNull());
        await act(async () => { screen.tree.root.findByType('iframe').props.onError(); });
        await screen.pressByTestIdAsync('artifact:htmlPreviewRetry');
        await vi.waitFor(() => expect(screen.findByTestId('artifact:htmlPreview')).not.toBeNull());
        expect(served.requests.filter(request => request.path === '/v1/artifacts/document')).toHaveLength(2);
        expect(served.requests.filter(request => request.path.endsWith('/html-preview'))).toHaveLength(2);
        await screen.unmount();
    });

    it('cancels a superseded revision and does not install its late private preview', async () => {
        const pending = createDeferred<Response>();
        let blobReads = 0;
        const { served, head, row, bytes, reference } = await setup('image', undefined, false, request => {
            if (!request.path.includes('/blobs/')) return;
            if (++blobReads === 1) return pending.promise;
            return Response.json({ blobId: reference.blobId, content: { t: 'plain', v: encodeBase64(bytes) } });
        });
        const screen = await renderScreen(<OpenView id="document" />);
        await vi.waitFor(() => expect(blobReads).toBe(1));
        head.headerVersion = 2;
        head.bodyVersion = 2;
        await act(async () => { getStorage().getState().updateArtifact({ ...row, headerVersion: 2, bodyVersion: 2 }); });
        await vi.waitFor(() => expect(screen.findByTestId('artifact:viewerBody')).not.toBeNull());
        expect(getStorage().getState().artifacts.document?.bodyVersion).toBe(2);
        expect(served.requests.filter(request => request.path === '/v1/artifacts/document')).toHaveLength(2);
        expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
        pending.resolve(Response.json({ blobId: reference.blobId, content: { t: 'plain', v: encodeBase64(bytes) } }));
        await flushHookEffects();
        expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
        await screen.unmount();
    });
});
