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

const filePath = 'assets/logo-dark.svg';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="black" /></svg>';
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
let transfer: ReturnType<typeof createSessionFileNativeTransferBoundary>;
let actionRequests: string[];
let readInputs: unknown[];
let scmDiff = '';
let portalBoundary: ReturnType<typeof installReactDomPortalBoundaryForTests>;
// Compile and load the real runtime graph during collection, as the other composed File tests do.
await prepareSessionFilesViewTestkit();
const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');
const { ImageWell } = await import('@/components/ui/media/ImageWell');
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
    scmDiff = '';
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
        rpc: request => request.method === 'scm.diff.file' ? { success: true, diff: scmDiff } : transfer.rpc(request) });
    fixture.storage.getState().updateWorkspaceScmSnapshot(fixture.scope, fileViewSnapshot());
});
afterEach(async () => { standardCleanup(); await fixture?.dispose(); portalBoundary?.restore(); vi.unstubAllGlobals(); });

describe('SVG File page preview dispatch', () => {
    it('mentions the file through the shared chooser and real mounted composer transaction owner', async () => {
        const { createExistingSessionComposerDocumentOwner } = await import('@/components/sessions/composer/existingSessionComposerDocumentOwner');
        const { projectComposerDocumentSnapshot } = await import('@/components/sessions/composer/composerSnapshotProjection');
        const { registerSessionComposerPresentationTarget } = await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
        const { FilePageHeader } = await import('../file/FilePageHeader');
        const { ComposerEntityDropTarget } = await import('@/components/sessions/composer/ComposerEntityDropTarget');
        const { SelectionList } = await import('@/components/ui/selectionList');
        const scope = { serverId: fixture.scope.serverId, accountId: 'alice' };
        const ref = { kind: 'session' as const, sessionId: fixture.session.id };
        const document = createExistingSessionComposerDocumentOwner({ scope, ref });
        document.replaceDocument({ text: 'Explain', structuredInputMentions: [], composerAttachments: [] });
        let unregister = () => {};
        try {
            await act(async () => {
                unregister = registerSessionComposerPresentationTarget({ serverId: scope.serverId, sessionId: ref.sessionId }, {
                    readRevision: () => document.read().revision,
                    readScope: () => scope,
                    readSnapshot: () => projectComposerDocumentSnapshot({ owner: document, attachmentCatalog: { entriesById: null },
                        presentation: { layout: 'wrap', focused: false, editable: true, submittable: true, submitting: false, running: false } }),
                    replace: (text, revision) => revision === document.read().revision
                        ? document.replaceDocument({ ...document.read().document, text }) : document.read().revision,
                    commitDocument: ({ expectedRevision, mutation }) => document.apply(expectedRevision, mutation),
                });
            });
            const screen = await fixture.render(<ModalProvider>
                <WorkspaceFileDetailsView targetKind="session" scopeId="session:share" scope={fixture.scope}
                    filePath={filePath} sessionIdForAugmentation={fixture.session.id} />
                <ComposerEntityDropTarget id="file-share-composer" scope={scope} refValue={ref} bounds={() => null}
                    inputRef={{ current: null }} presented editable fileScope={fixture.scope} kinds={['file']} />
            </ModalProvider>);
            await vi.waitFor(() => expect(screen.getTextContent()).toContain(svg));
            await flushHookEffects({ cycles: 4 });
            const attach = screen.findByType(FilePageHeader).props.menuActions.find((item: { id: string }) => item.id === 'mentionInComposer');
            expect(attach).toBeDefined();
            let completion: Promise<void> | undefined;
            await act(async () => { completion = attach.onSelect(); });
            await vi.waitFor(() => expect(screen.root.findAllByType(SelectionList)).toHaveLength(1));
            const chooser = screen.findByType(SelectionList);
            const options = chooser.props.rootStep.sections.flatMap((section: { options: Array<{ id: string; disabled?: boolean }> }) => section.options);
            const option = options.find((item: { disabled?: boolean }) => !item.disabled);
            expect(option, JSON.stringify(options)).toBeDefined();
            await act(async () => { chooser.props.onSelect(option.id); });
            await act(async () => { await completion; });
            expect(document.read().document.text).toContain('Explain');
            expect(document.read().document.text).toContain('logo-dark.svg');
            expect(document.read().document.structuredInputMentions).toHaveLength(1);
            await screen.unmount();
        } finally { unregister(); }
    });

    it.each(['card', 'chooser'])('opens binary-classified bytes as read-only text from the real %s', async (entry) => {
        const binaryPath = 'opaque.bin';
        const text = 'misclassified source text\n';
        fixture.storage.getState().applySettingsLocal({ filesEditorWebMonacoEnabled: true,
            featureToggles: { ...fixture.storage.getState().settings.featureToggles, 'files.editor': true } });
        transfer.setPayload(new TextEncoder().encode(text), binaryPath);
        fixture.storage.getState().updateWorkspaceScmSnapshot(fixture.scope, fileViewSnapshot({
            entries: [{ path: binaryPath, kind: 'modified', includeStatus: 'unmodified', pendingStatus: 'modified',
                hasIncludedDelta: false, hasPendingDelta: true, previousPath: null,
                stats: { pendingAdded: 0, pendingRemoved: 0, includedAdded: 0, includedRemoved: 0, isBinary: true } }],
        }));
        const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
        const target = { ...fixture.scope, kind: 'project' as const, workspaceRefId: 'project:text-preview' };
        const host = {
            targetKind: 'project' as const, projection: EMPTY_PLUGIN_UI_PROJECTION, platform: 'web' as const,
            scopedLaunchFacts: { ...fixture.scope, interactionEnabled: true },
            details: {
                tab: { key: `file:${binaryPath}`, kind: 'workspace-file', title: binaryPath,
                    resource: { filePath: binaryPath }, isPreview: true, isPinned: false },
                descriptor: { surfaceId: 'workspace-file', resourceKey: `file:${binaryPath}`, scope: target,
                    region: 'details', status: 'available' },
                scope: target, region: 'details', active: true, callbacks: {},
            },
        } satisfies import('./WorkspaceFileDetailsView').WorkspaceFileOpenableContentViewerHost;
        const screen = await fixture.render(<ModalProvider>
            <WorkspaceFileDetailsView scopeId="project:text-preview" scope={fixture.scope} filePath={binaryPath}
                sessionIdForAugmentation={null} openableContentViewer={host} />
        </ModalProvider>);
        try {
            await vi.waitFor(() => expect(screen.findByTestId('file-viewer-body-identity-learn-more')).not.toBeNull());
            expect(readInputs).toEqual([]);
            const entryId = entry === 'card' ? 'file-viewer-body-identity-learn-more' : 'plugin-details-viewer-choice:text';
            await vi.waitFor(() => expect(screen.findByTestId(entryId)).not.toBeNull());
            await screen.pressByTestIdAsync(entryId);
            await vi.waitFor(() => expect(screen.getTextContent()).toContain(text.trim()));
            expect(screen.findByTestId('file-viewer-body-identity')).toBeNull();
            const { FilePageHeader } = await import('../file/FilePageHeader');
            expect(screen.findByType(FilePageHeader).props.fileEditorEnabled).toBe(false);
            expect(readInputs).toContainEqual(expect.objectContaining({ path: '/workspace/opaque.bin' }));
        } finally { await screen.unmount(); }
    });

    it.each([false, true])('offers Open Changes only when the shown scope has changes for the file (changed %s)', async (changed) => {
        const textPath = 'notes.txt';
        transfer.setPayload(new TextEncoder().encode('plain notes\n'), textPath);
        if (changed) {
            scmDiff = 'diff --git a/notes.txt b/notes.txt\n@@ -1 +1 @@\n-old notes\n+plain notes\n';
            fixture.storage.getState().updateWorkspaceScmSnapshot(fixture.scope, fileViewSnapshot({
                entries: [{ path: textPath, kind: 'modified', includeStatus: 'unmodified', pendingStatus: 'modified',
                    hasIncludedDelta: false, hasPendingDelta: true, previousPath: null,
                    stats: { pendingAdded: 1, pendingRemoved: 1, includedAdded: 0, includedRemoved: 0, isBinary: false } }],
            }));
        }
        const onOpenChanges = vi.fn();
        const screen = await fixture.render(<ModalProvider>
            <WorkspaceFileDetailsView scopeId="workspace:open-changes" scope={fixture.scope} filePath={textPath}
                sessionIdForAugmentation={null} onOpenChanges={onOpenChanges} />
        </ModalProvider>);
        try {
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('plain notes'));
            await flushHookEffects({ cycles: 4 });
            const { FilePageHeader } = await import('../file/FilePageHeader');
            const ids = () => screen.findByType(FilePageHeader).props.menuActions.map((item: { id: string }) => item.id);
            // The same predicate as Discard all changes in this file: the two appear and disappear together.
            if (changed) await vi.waitFor(() => expect(ids()).toContain('discard'));
            expect(ids().includes('openChanges')).toBe(changed);
            expect(ids().includes('discard')).toBe(changed);
        } finally { await screen.unmount(); }
    });

    it('draws no viewer choice band for a text file that has nothing else to open with', async () => {
        const textPath = 'notes.txt';
        const text = 'plain notes\n';
        transfer.setPayload(new TextEncoder().encode(text), textPath);
        const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
        const target = { ...fixture.scope, kind: 'project' as const, workspaceRefId: 'project:text-notes' };
        const host = {
            targetKind: 'project' as const, projection: EMPTY_PLUGIN_UI_PROJECTION, platform: 'web' as const,
            scopedLaunchFacts: { ...fixture.scope, interactionEnabled: true },
            details: {
                tab: { key: `file:${textPath}`, kind: 'workspace-file', title: textPath,
                    resource: { filePath: textPath }, isPreview: true, isPinned: false },
                descriptor: { surfaceId: 'workspace-file', resourceKey: `file:${textPath}`, scope: target,
                    region: 'details', status: 'available' },
                scope: target, region: 'details', active: true, callbacks: {},
            },
        } satisfies import('./WorkspaceFileDetailsView').WorkspaceFileOpenableContentViewerHost;
        const screen = await fixture.render(<ModalProvider>
            <WorkspaceFileDetailsView scopeId="project:text-notes" scope={fixture.scope} filePath={textPath}
                sessionIdForAugmentation={null} openableContentViewer={host} />
        </ModalProvider>);
        try {
            await vi.waitFor(() => expect(screen.getTextContent()).toContain(text.trim()));
            await flushHookEffects({ cycles: 4 });
            expect(screen.findByTestId('plugin-details-viewer-choice:builtin')).toBeNull();
            expect(screen.findByTestId('plugin-details-viewer-choice:text')).toBeNull();
            // ⋯ › Info opens the facts of this file (the text's encoding facts are an object, not a name).
            const { FilePageHeader } = await import('../file/FilePageHeader');
            const info = screen.findByType(FilePageHeader).props.menuActions.find((item: { id: string }) => item.id === 'info');
            await act(async () => { await info.onSelect(); });
            await vi.waitFor(() => expect(screen.findByTestId('file-info-dialog')).not.toBeNull());
            expect(screen.findByTestId('file-info-lines')).not.toBeNull();
            await act(async () => Modal.hideAll());
        } finally { await screen.unmount(); }
    });

    it.each([null, 's1'])('keeps the Project link and publication source with augmentation %s', async (augmentation) => {
        applyProjectAccountRowsFixture(fixture.storage, { workspaceRefs: [{ ...fixture.scope, id: 'project-svg', label: null,
            createdAtMs: 1, lastOpenedAtMs: null }] });
        const screen = await fixture.render(<ModalProvider>
            <WorkspaceFileDetailsView scopeId="project:svg-preview" targetKind="project" workspaceRefId="project-svg"
                scope={fixture.scope} filePath={filePath} sessionIdForAugmentation={augmentation} />
        </ModalProvider>);
        try {
            await vi.waitFor(() => expect(screen.getTextContent()).toContain(svg));
            const { FilePageHeader } = await import('../file/FilePageHeader');
            const ids = screen.findByType(FilePageHeader).props.menuActions.map((item: { id: string }) => item.id);
            expect(ids).toEqual(expect.arrayContaining(['copyLink', 'info', 'background', 'saveAsArtifact']));
            await act(async () => { await screen.findByType(FilePageHeader).props.menuActions.find((item: { id: string }) => item.id === 'saveAsArtifact').onSelect(); });
            const { SaveFileAsArtifactDialog } = await import('../file/SaveFileAsArtifactDialog');
            const dialog = screen.findByType(SaveFileAsArtifactDialog);
            expect(dialog.props.source).toMatchObject({ sourceSessionId: null,
                sourceWorkspace: { machineId: fixture.scope.machineId, rootPath: fixture.scope.rootPath } });
            expect(dialog.props.onOpenArtifact).toEqual(expect.any(Function));
            await vi.waitFor(() => expect(screen.findByTestId('save-as-artifact-save')?.props.disabled).toBe(false));
            await act(async () => Modal.hideAll());
            await flushHookEffects({ cycles: 4 });
            const menu = screen.findByType(FilePageHeader).props.menuActions;
            const alerts = vi.spyOn(Modal, 'alert');
            await act(async () => { await menu.find((item: { id: string }) => item.id === 'copyLink').onSelect(); });
            const { buildWorkspaceFileLink } = await import('@/utils/url/sessionFileDeepLink');
            expect(clipboard.setStringAsync.mock.calls.at(-1)?.[0], JSON.stringify({ ui: screen.getTextContent(), alerts: alerts.mock.calls })).toBe(buildWorkspaceFileLink({
                target: { kind: 'project', workspaceRefId: 'project-svg', ...fixture.scope }, path: filePath,
            }));
            await act(async () => { await menu.find((item: { id: string }) => item.id === 'copyPath').onSelect({ altKey: true }); });
            expect(clipboard.setStringAsync).toHaveBeenLastCalledWith(`/workspace/${filePath}`);
        } finally { await screen.unmount(); }
    });

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
