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
import { createAccountSettingsHttpBoundary } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createPluginDeclarativeModelFixture } from '@/dev/testkit/fixtures/pluginDeclarativeModelFixture';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { normalizePluginUiProjection, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { DetailsSurfaceRenderInputV1 } from '@/components/appShell/panes/details/surfaces/types';
import type { DetailsTabState } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

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
let viewerStatBytes: Uint8Array | null;
let settingsRequests: Array<{ method: string; status: number }>;
// Compile and load the real runtime graph during collection, as the other composed File tests do.
await prepareSessionFilesViewTestkit();
const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');
const { ImageWell } = await import('@/components/ui/media/ImageWell');
const { Modal, ModalProvider } = await import('@/modal');
const { PluginDetailsDestinationLaunchScope, createPluginDetailsDestinationSurfaceRenderer } = await import('@/components/appShell/panes/details/surfaces/pluginDetailsDestination');

function installedViewerProjection() {
    const installedPackagesById: Record<string, unknown> = {};
    const entriesById: Record<string, unknown> = {};
    for (let index = 1; index <= 11; index += 1) {
        const suffix = String(index).padStart(2, '0');
        const pluginId = `com.external.viewer-${suffix}`;
        const occurrenceId = `${pluginId}#1`;
        const executionOrigin = { serverIdentityId: 'srv_svg_preview', materializationRef: {
            machineId: fixture.scope.machineId, materializationId: `${pluginId}-installed`, pluginId,
        } };
        const binding = normalizePluginUiDestinationBindingV1({ pluginId, destinationId: 'text-viewer',
            rendererId: 'text-renderer', container: 'detailsTab', target: { kind: 'project' }, instancePolicy: 'singleton' });
        if (!binding) throw new Error('External viewer fixture must have an admitted destination');
        installedPackagesById[pluginId] = { id: pluginId, displayName: `External viewer ${suffix}`, version: '1.0.0',
            enabled: true, occurrenceId, source: { kind: 'path', locator: `/plugins/${pluginId}` },
            sourceCustody: { kind: 'development', registeredRootId: `${pluginId}-root` }, declaresContributionPoints: false };
        const viewerId = `openableContentViewer:${pluginId}:text`;
        entriesById[viewerId] = { id: viewerId, pluginId, occurrenceId, executionOrigin,
            contributionKind: 'openableContentViewer', descriptorId: 'text', identity: { pluginId, localId: 'text' },
            viewer: { contentClasses: ['text'], mimeTypes: ['text/plain'] }, destination: { pluginId, localId: 'text-viewer' } };
        const placementId = `surfacePlacement:${pluginId}:text-viewer`;
        entriesById[placementId] = { id: placementId, pluginId, occurrenceId, executionOrigin,
            contributionKind: 'surfacePlacement', descriptorId: 'text-viewer', binding, target: binding.target,
            renderer: { kind: 'declarative', contributionId: 'text-renderer', model: createPluginDeclarativeModelFixture({
                pluginId, localId: 'text-renderer', occurrenceId,
                document: { version: 1, root: { kind: 'text', text: `External viewer ${suffix} mounted` } },
            }) }, display: { developerFallback: `External viewer ${suffix}` },
            availability: { state: 'available', reason: 'available', diagnostics: [] } };
    }
    // This is the daemon wire boundary; matching, choice and mount normalization remain real.
    return normalizePluginUiProjection(PluginProjectionV2Schema.parse({ v: 2, generation: 1,
        installedPackagesById, actionsById: {}, familiesById: { pluginUi: { family: 'pluginUi', entriesById } } }), 'web');
}

function InstalledViewerFileHost(props: Readonly<{ projection: PluginUiProjectionModel }>) {
    const [tab, setTab] = React.useState<DetailsTabState>({ key: 'file:notes.txt', kind: 'workspace-file',
        title: 'notes.txt', resource: { filePath: 'notes.txt' }, isPinned: true, isPreview: false });
    const scope = { ...fixture.scope, kind: 'project' as const, workspaceRefId: 'project:installed-viewers' };
    const details: DetailsSurfaceRenderInputV1 = { tab, scope, region: 'details', active: true,
        descriptor: { surfaceId: tab.kind, resourceKey: tab.key, scope, region: 'details', status: 'available' },
        callbacks: { replaceTab: (_key, next) => setTab({ ...next, isPinned: true, isPreview: false }) } };
    const renderer = createPluginDetailsDestinationSurfaceRenderer({ targetKind: 'project', projection: props.projection,
        mount: { ...fixture.scope, projectId: scope.workspaceRefId, platform: 'web', formFactor: 'tablet',
            projectionPhase: 'current', projectionInteractionEnabled: true } });
    return <PluginDetailsDestinationLaunchScope>{renderer.canRender(details) ? renderer.render(details) : (
        <WorkspaceFileDetailsView targetKind="project" workspaceRefId={scope.workspaceRefId}
            scopeId="project:installed-viewers" scope={fixture.scope} filePath="notes.txt" sessionIdForAugmentation={null}
            openableContentViewer={{ targetKind: 'project', projection: props.projection, platform: 'web',
                scopedLaunchFacts: { ...fixture.scope, interactionEnabled: true }, details }} />
    )}</PluginDetailsDestinationLaunchScope>;
}
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
    viewerStatBytes = null;
    settingsRequests = [];
    transfer = createSessionFileNativeTransferBoundary({ bytes: new TextEncoder().encode(svg), name: filePath });
    const settings = createAccountSettingsHttpBoundary({ serverUrl: 'https://session-file-views.test',
        initialAccounts: [{ accountId: 'alice', snapshot: { content: { t: 'plain', v: {} }, version: 0 } }] });
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
            const settingsResponse = settings.handle(url, init);
            if (settingsResponse) {
                settingsRequests.push({ method: init?.method ?? 'GET', status: settingsResponse.status });
                return settingsResponse;
            }
            const parsed = new URL(String(url));
            if (parsed.pathname.startsWith('/v1/actions/')) actionRequests.push(parsed.pathname);
            if (parsed.pathname === '/v1/machines/m1') return Response.json({ machine: read.machine });
            return await read.handle(parsed, init) ?? transfer.request(url, init);
        },
        rpc: request => request.method === 'scm.diff.file' ? { success: true, diff: scmDiff }
            : request.method === RPC_METHODS.STAT_FILE && viewerStatBytes
                ? { success: true, exists: true, kind: 'file', sizeBytes: viewerStatBytes.byteLength,
                    modifiedMs: 1, contentHash: bytesToHex(sha256(viewerStatBytes)) }
                : transfer.rpc(request) });
    fixture.storage.getState().updateWorkspaceScmSnapshot(fixture.scope, fileViewSnapshot());
});
afterEach(async () => { standardCleanup(); await fixture?.dispose(); portalBoundary?.restore(); vi.unstubAllGlobals(); });

describe('SVG File page preview dispatch', () => {
    it('offers the eleventh installed external viewer and selects it through Settings into the real destination mount', async () => {
        const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const accountScope = getActiveServerAccountScope();
        if (!accountScope) throw new Error('Installed viewer fixture requires the restored Account');
        // Seed the initial server snapshot through the real scoped Settings owner, as the other Action fixtures do.
        await fixture.storage.getState().activateSettingsScope(accountScope);
        fixture.storage.getState().applySettingsForScope(accountScope, settingsParse({}), 0);
        // Openable content requires the daemon's byte-revision facts, not the cheap browsing stat.
        viewerStatBytes = new TextEncoder().encode('plain notes\n');
        transfer.setPayload(viewerStatBytes, 'notes.txt');
        applyProjectAccountRowsFixture(fixture.storage, { workspaceRefs: [{ ...fixture.scope,
            id: 'project:installed-viewers', label: null, createdAtMs: 1, lastOpenedAtMs: null }] });
        const screen = await fixture.render(<ModalProvider><InstalledViewerFileHost projection={installedViewerProjection()} /></ModalProvider>);
        const lastChoice = 'plugin-details-viewer-choice:openableContentViewer:com.external.viewer-11:text';
        try {
            await vi.waitFor(() => expect(screen.findByTestId('plugin-details-viewer-choice:openableContentViewer:com.external.viewer-01:text'), screen.getTextContent()).not.toBeNull());
            // A real matching contribution beyond the old cap must be offered, not merely kept in a catalog.
            expect(screen.findByTestId(lastChoice)).not.toBeNull();
            await vi.waitFor(() => expect(screen.findByTestId(lastChoice)?.props.disabled).not.toBe(true));
            await screen.pressByTestIdAsync(lastChoice);
            await vi.waitFor(() => expect(fixture.storage.getState().settings.workspaceFileViewerPreferencesV1,
                JSON.stringify({ settingsRequests, settingsVersion: fixture.storage.getState().settingsVersion,
                    settingsScope: fixture.storage.getState().settingsScope, text: screen.getTextContent() })).toMatchObject({
                v: 1, selections: { 'mime:text/plain': { kind: 'plugin', pluginId: 'com.external.viewer-11', contributionLocalId: 'text' } },
            }));
            expect(settingsRequests).toContainEqual({ method: 'POST', status: 200 });
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('External viewer 11 mounted'));
            await screen.pressByTestIdAsync('plugin-details-viewer-choice:builtin');
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('plain notes'));
            expect(screen.getTextContent()).not.toContain('External viewer 11 mounted');
        } finally { await screen.unmount(); }
    });

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
            await vi.waitFor(() => expect(screen.findAllByType(ImageWell)).toHaveLength(1));
            await flushHookEffects({ cycles: 4 });
            const attach = screen.findByType(FilePageHeader).props.menuActions.find((item: { id: string }) => item.id === 'mentionInComposer');
            expect(attach).toBeDefined();
            let completion: Promise<void> | undefined;
            await act(async () => { completion = attach.onSelect(); });
            // The lazy modal mounts before its effect opens the staged carry.
            // Wait for the real actionable destination, not just the list shell.
            await vi.waitFor(async () => {
                await flushHookEffects();
                expect(screen.root.findAllByType(SelectionList)).toHaveLength(1);
                const options = screen.findByType(SelectionList).props.rootStep.sections
                    .flatMap((section: { options: Array<{ id: string; disabled?: boolean }> }) => section.options);
                expect(options.some((item: { disabled?: boolean }) => !item.disabled), JSON.stringify(options)).toBe(true);
            });
            const chooser = screen.findByType(SelectionList);
            const options = chooser.props.rootStep.sections.flatMap((section: { options: Array<{ id: string; disabled?: boolean }> }) => section.options);
            const option = options.find((item: { disabled?: boolean }) => !item.disabled);
            await act(async () => { chooser.props.onSelect(option.id); });
            await act(async () => { await completion; });
            expect(document.read().document.text).toContain('Explain');
            expect(document.read().document.text).toContain('logo-dark.svg');
            expect(document.read().document.structuredInputMentions).toHaveLength(1);
            await screen.unmount();
        } finally { unregister(); }
    });

    it('opens binary-classified bytes as read-only text from the card, its one entry, and returns through the chooser', async () => {
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
            await flushHookEffects({ cycles: 4 });
            expect(readInputs).toEqual([]);
            // One entry point (lab FV2b): the identity card's quiet "Open as text" link. No chooser band repeats it.
            expect(screen.findByTestId('plugin-details-viewer-choice:text')).toBeNull();
            expect(screen.findByTestId('plugin-details-viewer-choice:builtin')).toBeNull();
            await screen.pressByTestIdAsync('file-viewer-body-identity-learn-more');
            await vi.waitFor(() => expect(screen.getTextContent()).toContain(text.trim()));
            expect(screen.findByTestId('file-viewer-body-identity')).toBeNull();
            const { FilePageHeader } = await import('../file/FilePageHeader');
            expect(screen.findByType(FilePageHeader).props.fileEditorEnabled).toBe(false);
            expect(readInputs).toContainEqual(expect.objectContaining({ path: '/workspace/opaque.bin' }));
            // Once the card has gone, the chooser is the way back to the built-in view.
            await vi.waitFor(() => expect(screen.findByTestId('plugin-details-viewer-choice:builtin'), screen.getTextContent()).not.toBeNull());
            await screen.pressByTestIdAsync('plugin-details-viewer-choice:builtin');
            await vi.waitFor(() => expect(screen.findByTestId('file-viewer-body-identity'), screen.getTextContent()).not.toBeNull());
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
            await vi.waitFor(() => expect(screen.findAllByType(ImageWell)).toHaveLength(1));
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

    it('opens held XML in the image Preview, switches to Source and back, then opens those held bytes in the stage', async () => {
        const screen = await fixture.render(<ModalProvider>
            <WorkspaceFileDetailsView scopeId="project:svg-preview" scope={fixture.scope} filePath={filePath} sessionIdForAugmentation={null} />
        </ModalProvider>);
        try {
            await vi.waitFor(() => expect({ actionRequests, readInputs }).toMatchObject({
                actionRequests: expect.arrayContaining(['/v1/actions/daemon.filesystem.readFile']),
                readInputs: expect.arrayContaining([expect.objectContaining({ path: '/workspace/assets/logo-dark.svg' })]),
            }));
            // An SVG renders as an image (PROGRAM D-F1): Preview is the default view and Source is one tap away.
            await vi.waitFor(() => expect(screen.findAllByType(ImageWell)).toHaveLength(1));
            // Its facts say what the picture is, never how many lines its XML has (lab FV4s "646 × 854 · SVG · 8.5 KB").
            const { FilePageHeader } = await import('../file/FilePageHeader');
            const facts = () => (screen.findByType(FilePageHeader).props.summaryFacts ?? []) as readonly string[];
            expect(facts()).toContain('SVG image');
            expect(facts().some((fact) => /line/i.test(fact))).toBe(false);
            await screen.pressByTestIdAsync('file-details-view-mode:file');
            expect(screen.findAllByType(ImageWell)).toHaveLength(0);
            expect(screen.getTextContent()).toContain(svg);
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
