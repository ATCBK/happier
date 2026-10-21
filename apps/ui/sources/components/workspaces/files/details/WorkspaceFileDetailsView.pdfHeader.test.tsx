// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, fileViewSnapshot, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { createSessionFileNativeTransferBoundary } from '@/components/sessions/files/sessionFileNativeTransferTestkit';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { getVitestNodeBuiltin } from '@/dev/vitestNodeBuiltins';
import { installReactDomPortalBoundaryForTests } from '@/dev/testkit/mocks/reactDom';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';

const clipboard = vi.hoisted(() => ({ setStringAsync: vi.fn(async (_text: string) => true) }));
vi.mock('expo-clipboard', () => clipboard);

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const { createCapturingFlatListMock } = await import('@/dev/testkit/mocks/virtualizedList');
    // The host renderer has no measured RN list viewport; real File code rows still render.
    return createReactNativeWebMock(createCapturingFlatListMock({ renderItems: true }).module);
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

const filePath = 'docs/retry-guide.pdf';
// A PDF header with a NUL byte: the page reads it as binary bytes, never as text.
const pdfBytes = new Uint8Array([...new TextEncoder().encode('%PDF-1.4\n'), 0, 1, 2, 3]);
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
let transfer: ReturnType<typeof createSessionFileNativeTransferBoundary>;
let actionRequests: string[];
let readInputs: unknown[];
let portalBoundary: ReturnType<typeof installReactDomPortalBoundaryForTests>;
// Compile and load the real runtime graph during collection, as the other composed File tests do.
await prepareSessionFilesViewTestkit();
const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');
const { FileViewerBody } = await import('../file/FileViewerBody');
const { FilePageHeader } = await import('../file/FilePageHeader');
const { PdfZoomMenu } = await import('@/components/ui/media/pdf/PdfZoomMenu');
const { Modal, ModalProvider } = await import('@/modal');
beforeEach(async () => {
    standardCleanup();
    clipboard.setStringAsync.mockClear();
    // jsdom supplies the web modal DOM; Node supplies real, fetchable Blob URLs.
    vi.stubGlobal('Blob', getVitestNodeBuiltin<typeof import('node:buffer')>('node:buffer').Blob);
    vi.stubGlobal('URL', getVitestNodeBuiltin<typeof import('node:url')>('node:url').URL);
    portalBoundary = installReactDomPortalBoundaryForTests();
    actionRequests = [];
    readInputs = [];
    transfer = createSessionFileNativeTransferBoundary({ bytes: pdfBytes, name: filePath });
    const read = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://session-file-views.test',
        serverIdentityId: 'srv_pdf_header', accountId: 'alice', machineId: 'm1', tokenEpoch: 0,
        actionId: 'daemon.filesystem.readFile', execute: input => {
            readInputs.push(input);
            return transfer.rpc({ targetId: 'm1',
                method: getActionSpec('daemon.filesystem.readFile').bindings!.rpcMethod!, payload: input });
        } });
    fixture = await createSessionFilesViewFixture({ serverIdentityId: 'srv_pdf_header', machineCarrierOrigin: transfer.origin,
        // Private requester admission needs current Account provenance, not the legacy Home token default.
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) },
        request: async (url, init) => {
            const parsed = new URL(String(url));
            if (parsed.pathname.startsWith('/v1/actions/')) actionRequests.push(parsed.pathname);
            if (parsed.pathname === '/v1/machines/m1') return Response.json({ machine: read.machine });
            return await read.handle(parsed, init) ?? transfer.request(url, init);
        },
        rpc: request => request.method === 'scm.diff.file' ? { success: true, diff: '' } : transfer.rpc(request) });
    fixture.storage.getState().updateWorkspaceScmSnapshot(fixture.scope, fileViewSnapshot({
        entries: [{ path: filePath, kind: 'modified', includeStatus: 'unmodified', pendingStatus: 'modified',
            hasIncludedDelta: false, hasPendingDelta: true, previousPath: null,
            stats: { pendingAdded: 0, pendingRemoved: 0, includedAdded: 0, includedRemoved: 0, isBinary: true } }],
    }));
});
afterEach(async () => { standardCleanup(); await fixture?.dispose(); portalBoundary?.restore(); vi.unstubAllGlobals(); });

describe('PDF File page header (lab files FV5)', () => {
    it('carries the zoom menu and Find, and names the page count the viewer reports', async () => {
        const screen = await fixture.render(<ModalProvider>
            <WorkspaceFileDetailsView scopeId="project:pdf-header" scope={fixture.scope} filePath={filePath} sessionIdForAugmentation={null} />
        </ModalProvider>);
        try {
            await vi.waitFor(() => expect(screen.findAllByType(FileViewerBody)).toHaveLength(1));
            const header = () => screen.findByType(FilePageHeader);
            const body = () => screen.findByType(FileViewerBody);
            // Find opens the PDF's own Find surface (the viewer registers it under the page's id).
            expect(header().props.find).toEqual(expect.objectContaining({ onOpen: expect.any(Function) }));
            // One zoom: the header's menu drives the viewer the page mounts.
            const zoom = () => screen.findByType(PdfZoomMenu);
            expect(zoom().props.zoom).toBe('fit-width');
            expect(body().props.pdf?.zoom).toBe('fit-width');
            await act(async () => { zoom().props.onZoomChange(2); });
            expect(body().props.pdf?.zoom).toBe(2);
            expect(zoom().props.zoom).toBe(2);
            // The viewer's page facts reach the facts line once it knows them.
            await act(async () => { body().props.pdf?.onPageInfo?.({ page: 3, total: 14 }); });
            expect(header().props.summaryFacts).toEqual(expect.arrayContaining(['14 pages']));
        } finally { await act(async () => { await screen.unmount(); }); }
    });
});
