// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, fileViewSnapshot, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { createSessionFileNativeTransferBoundary } from '@/components/sessions/files/sessionFileNativeTransferTestkit';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { getVitestNodeBuiltin } from '@/dev/vitestNodeBuiltins';
import { installReactDomPortalBoundaryForTests } from '@/dev/testkit/mocks/reactDom';

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

const filePath = 'assets/logo-dark.svg';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="black" /></svg>';
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
let transfer: ReturnType<typeof createSessionFileNativeTransferBoundary>;
let actionRequests: string[];
let readInputs: unknown[];
let portalBoundary: ReturnType<typeof installReactDomPortalBoundaryForTests>;
// Compile and load the real runtime graph during collection, as the other composed File tests do.
await prepareSessionFilesViewTestkit();
const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');
const { ImageWell } = await import('@/components/ui/media/ImageWell');
const { Modal, ModalProvider } = await import('@/modal');
beforeEach(async () => {
    standardCleanup();
    // jsdom supplies the web modal DOM; Node supplies real, fetchable Blob URLs.
    vi.stubGlobal('Blob', getVitestNodeBuiltin<typeof import('node:buffer')>('node:buffer').Blob);
    vi.stubGlobal('URL', getVitestNodeBuiltin<typeof import('node:url')>('node:url').URL);
    portalBoundary = installReactDomPortalBoundaryForTests();
    actionRequests = [];
    readInputs = [];
    transfer = createSessionFileNativeTransferBoundary({ bytes: new TextEncoder().encode(svg), name: filePath });
    const read = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://session-file-views.test',
        serverIdentityId: 'srv_svg_preview', accountId: 'alice', machineId: 'm1', tokenEpoch: 0,
        actionId: 'daemon.filesystem.readFile', execute: input => {
            readInputs.push(input);
            return transfer.rpc({ targetId: 'm1',
                method: getActionSpec('daemon.filesystem.readFile').bindings!.rpcMethod!, payload: input });
        } });
    fixture = await createSessionFilesViewFixture({ serverIdentityId: 'srv_svg_preview', machineCarrierOrigin: transfer.origin,
        // Private requester admission needs current Account provenance, not the legacy Home token default.
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) },
        request: async (url, init) => {
            const parsed = new URL(String(url));
            if (parsed.pathname.startsWith('/v1/actions/')) actionRequests.push(parsed.pathname);
            if (parsed.pathname === '/v1/machines/m1') return Response.json({ machine: read.machine });
            return await read.handle(parsed, init) ?? transfer.request(url, init);
        },
        rpc: request => request.method === 'scm.diff.file' ? { success: true, diff: '' } : transfer.rpc(request) });
    fixture.storage.getState().updateWorkspaceScmSnapshot(fixture.scope, fileViewSnapshot());
});
afterEach(async () => { standardCleanup(); await fixture?.dispose(); portalBoundary?.restore(); vi.unstubAllGlobals(); });

describe('SVG File page preview dispatch', () => {
    it('switches held XML between Source and the image Preview, then opens those held bytes in the stage', async () => {
        const screen = await fixture.render(<ModalProvider>
            <WorkspaceFileDetailsView scopeId="project:svg-preview" scope={fixture.scope} filePath={filePath} sessionIdForAugmentation={null} />
        </ModalProvider>);
        try {
            await vi.waitFor(() => expect({ actionRequests, readInputs }).toMatchObject({
                actionRequests: expect.arrayContaining(['/v1/actions/daemon.filesystem.readFile']),
                readInputs: expect.arrayContaining([expect.objectContaining({ path: '/workspace/assets/logo-dark.svg' })]),
            }));
            await vi.waitFor(() => expect(screen.getTextContent()).toContain(svg));
            expect(screen.findAllByType(ImageWell)).toHaveLength(0);
            await screen.pressByTestIdAsync('file-details-view-mode:markdown');
            expect(screen.findAllByType(ImageWell)).toHaveLength(1);
            const previewUri = screen.findByTestId('file-viewer-body-picture')!.props.source.uri as string;
            expect(previewUri).toMatch(/^blob:/);
            expect(await (await fetch(previewUri)).text()).toBe(svg);
            expect(transfer.prepares).toHaveLength(0);

            await screen.pressByTestIdAsync('file-details-view-mode:file');
            expect(screen.findAllByType(ImageWell)).toHaveLength(0);
            expect(screen.getTextContent()).toContain(svg);
            await screen.pressByTestIdAsync('file-details-view-mode:markdown');
            await screen.pressByTestIdAsync('file-viewer-body-open');
            await vi.waitFor(() => expect(screen.findByTestId('media-stage-image')).not.toBeNull());
            const stageUri = screen.findByTestId('media-stage-image')!.props.source.uri as string;
            expect(stageUri).toMatch(/^blob:/);
            expect(await (await fetch(stageUri)).text()).toBe(svg);
            // File SVG is already read text: expansion must not start a binary file acquisition.
            expect(transfer.prepares).toHaveLength(0);

            await act(async () => Modal.hideAll());
            await screen.pressByTestIdAsync('file-details-view-mode:file');
            const updatedSvg = svg.replace('black', 'white');
            transfer.setPayload(new TextEncoder().encode(updatedSvg), filePath);
            // A changed working-tree entry publishes a refresh; timestamp-only equivalent snapshots are suppressed.
            await act(async () => fixture.storage.getState().updateWorkspaceScmSnapshot(fixture.scope, fileViewSnapshot({ fetchedAt: 2,
                entries: [{ path: filePath, kind: 'modified', includeStatus: 'unmodified', pendingStatus: 'modified',
                    hasIncludedDelta: false, hasPendingDelta: true, previousPath: null,
                    stats: { pendingAdded: 1, pendingRemoved: 1, includedAdded: 0, includedRemoved: 0, isBinary: false } }],
            })));
            await vi.waitFor(() => expect(screen.getTextContent()).toContain(updatedSvg));
            await screen.pressByTestIdAsync('file-details-view-mode:markdown');
            await screen.pressByTestIdAsync('file-viewer-body-open');
            await vi.waitFor(() => expect(screen.findByTestId('media-stage-image')).not.toBeNull());
            const updatedStageUri = screen.findByTestId('media-stage-image')!.props.source.uri as string;
            expect(await (await fetch(updatedStageUri)).text()).toBe(updatedSvg);
            expect(transfer.prepares).toHaveLength(0);
        } finally { await act(async () => { await screen.unmount(); }); }
    });
});
