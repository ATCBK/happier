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

const filePath = 'src/retry.ts';
const svg = 'export const attempts = 3;\nexport function retryLabel(): string { return `Retry ${attempts}`; }\n';
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
let transfer: ReturnType<typeof createSessionFileNativeTransferBoundary>;
let actionRequests: string[];
let readInputs: unknown[];
let scmDiff = '';
let portalBoundary: ReturnType<typeof installReactDomPortalBoundaryForTests>;
// Compile and load the real runtime graph during collection, as the other composed File tests do.
await prepareSessionFilesViewTestkit();
const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');
const { ModalProvider } = await import('@/modal');
beforeEach(async () => {
    standardCleanup();
    clipboard.setStringAsync.mockClear();
    // jsdom supplies the web modal DOM; Node supplies real, fetchable Blob URLs.
    vi.stubGlobal('Blob', getVitestNodeBuiltin<typeof import('node:buffer')>('node:buffer').Blob);
    vi.stubGlobal('URL', getVitestNodeBuiltin<typeof import('node:url')>('node:url').URL);
    portalBoundary = installReactDomPortalBoundaryForTests();
    actionRequests = [];
    readInputs = [];
    scmDiff = '';
    transfer = createSessionFileNativeTransferBoundary({ bytes: new TextEncoder().encode(svg), name: filePath });
    const read = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://session-file-views.test',
        serverIdentityId: 'srv_edit_swap', accountId: 'alice', machineId: 'm1', tokenEpoch: 0,
        actionId: 'daemon.filesystem.readFile', execute: input => {
            readInputs.push(input);
            return transfer.rpc({ targetId: 'm1',
                method: getActionSpec('daemon.filesystem.readFile').bindings!.rpcMethod!, payload: input });
        } });
    fixture = await createSessionFilesViewFixture({ serverIdentityId: 'srv_edit_swap', machineCarrierOrigin: transfer.origin,
        // Private requester admission needs current Account provenance, not the legacy Home token default.
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) },
        request: async (url, init) => {
            const parsed = new URL(String(url));
            if (parsed.pathname.startsWith('/v1/actions/')) actionRequests.push(parsed.pathname);
            if (parsed.pathname === '/v1/machines/m1') return Response.json({ machine: read.machine });
            return await read.handle(parsed, init) ?? transfer.request(url, init);
        },
        rpc: request => request.method === 'scm.diff.file' ? { success: true, diff: scmDiff } : transfer.rpc(request) });
    fixture.storage.getState().updateWorkspaceScmSnapshot(fixture.scope, fileViewSnapshot());
    // This page edits: the editor feature is on (the shared fixture leaves it off for read-only pages).
    fixture.storage.getState().applySettingsLocal({ experiments: true, featureToggles: { 'scm.writeOperations': true, 'files.reviewComments': false,
        'files.diffSyntaxHighlighting': false, 'files.editor': true } });
});
afterEach(async () => { standardCleanup(); await fixture?.dispose(); portalBoundary?.restore(); vi.unstubAllGlobals(); });

describe('File page View → Edit swap', () => {
    it('keeps the read view up until the editor reports ready, then swaps to the editor', async () => {
        const screen = await fixture.render(<ModalProvider>
            <WorkspaceFileDetailsView scopeId="project:edit-swap" scope={fixture.scope} filePath={filePath}
                sessionIdForAugmentation={null} />
        </ModalProvider>);
        try {
            const { FilePageHeader } = await import('../file/FilePageHeader');
            const { FileContentPanel } = await import('../file/FileContentPanel');
            const { FileEditorPanel } = await import('../file/editor/FileEditorPanel');
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('retryLabel'));
            await flushHookEffects({ cycles: 4 });
            await vi.waitFor(() => expect(screen.findByType(FilePageHeader).props.edit?.kind).toBe('edit'));
            await act(async () => { screen.findByType(FilePageHeader).props.edit.onPress(); });
            await flushHookEffects({ cycles: 4 });
            // The engine is still loading (a cold Monaco has not booted): the editor mounts beneath, unseen and
            // untouchable, while the code view the person was reading stays on screen (P4 §3.5, files lab ED1).
            await vi.waitFor(() => expect(screen.findAllByType(FileEditorPanel)).toHaveLength(1));
            expect(screen.findAllByType(FileContentPanel)).toHaveLength(1);
            const warming = screen.findByTestId('file-details-editor-warming');
            expect(warming?.props.pointerEvents).toBe('none');
            // The engine reports ready: one swap, the read view leaves and the editor is the body.
            await act(async () => { screen.findByType(FileEditorPanel).props.onReady?.(); });
            await flushHookEffects({ cycles: 2 });
            expect(screen.findAllByType(FileContentPanel)).toHaveLength(0);
            expect(screen.findByTestId('file-details-editor-warming')).toBeNull();
            expect(screen.findAllByType(FileEditorPanel)).toHaveLength(1);
        } finally { await screen.unmount(); }
    });
});
