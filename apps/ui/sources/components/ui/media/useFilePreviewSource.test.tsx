import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act } from 'react-test-renderer';
import type { ComposerContentHandleV1 } from '@happier-dev/protocol';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { FilesystemDownloadOutput } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';

import { renderHook, renderScreen } from '@/dev/testkit';
import { createSessionFileNativeTransferBoundary } from '@/components/sessions/files/sessionFileNativeTransferTestkit';
import { createSessionFilesViewFixture, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { transferMachine } from '@/components/sessions/files/sessionFileTransferTestkit';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { useFilePreviewSource } from './useFilePreviewSource';
import { buildImageCompareModel, projectImageComparePreview } from '@/components/workspaces/scm/review/imageCompare/imageCompareModel';
import { useImageCompare } from '@/components/workspaces/scm/review/imageCompare/useImageCompare';

const files = vi.hoisted(() => new Map<string, { exists: boolean; chunks: Uint8Array[]; closed: number; deletes: number }>());
const handoffs = vi.hoisted(() => ({ copies: [] as string[], shares: [] as number[][] }));
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' }, {
        Share: { sharedAction: 'shared', dismissedAction: 'dismissed', share: async ({ url }: { url: string }) => {
            handoffs.shares.push(files.get(url)!.chunks.flatMap(chunk => [...chunk]));
            return { action: 'shared' };
        } },
    });
});
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated'))
    .createReanimatedModuleMock({ settleTimingCallbacks: true }));
// Availability is the native share-sheet boundary; materialization and file handoff stay real.
vi.mock('expo-sharing', () => ({ isAvailableAsync: async () => true }));
// Accept the real Action owner's in-place read confirmation at the modal boundary.
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: true }).module;
});
// Expo's OS-backed file API is the sink boundary. The real preview source owns custody.
vi.mock('expo-file-system', () => ({
    Paths: { cache: 'file:///preview-cache' },
    Directory: class Directory {
        readonly uri: string;
        constructor(parent: string | { uri: string }, name?: string) { this.uri = (typeof parent === 'string' ? parent : parent.uri) + (name ? '/' + name : ''); }
        create() {}
    },
    File: class File {
        readonly uri: string;
        constructor(parent: string | { uri: string }, name?: string) {
            this.uri = (typeof parent === 'string' ? parent : parent.uri) + (name ? '/' + name : '');
            if (!files.has(this.uri)) files.set(this.uri, { exists: false, chunks: [], closed: 0, deletes: 0 });
        }
        create() { files.get(this.uri)!.exists = true; }
        delete() { const file = files.get(this.uri)!; file.exists = false; file.deletes++; }
        copy(destination: { uri: string }) {
            const source = files.get(this.uri)!;
            if (!source.exists) throw new Error('Preview was released before Save');
            handoffs.copies.push(this.uri);
            files.set(destination.uri, { exists: true, chunks: source.chunks.map(chunk => new Uint8Array(chunk)), closed: 0, deletes: 0 });
        }
        open() { const file = files.get(this.uri)!; return {
            offset: 0,
            writeBytes: (bytes: Uint8Array) => file.chunks.push(new Uint8Array(bytes)),
            close: () => { file.closed++; },
        }; }
    },
}));

describe('useFilePreviewSource', () => {
    let transfer: ReturnType<typeof createSessionFileNativeTransferBoundary>;
    let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
    let downloadFailure: Extract<FilesystemDownloadOutput, { success: false }> | null;
    let interruptTransfer: boolean;
    beforeAll(prepareSessionFilesViewTestkit);
    beforeEach(async () => {
        files.clear();
        handoffs.copies.length = 0;
        handoffs.shares.length = 0;
        downloadFailure = null;
        interruptTransfer = false;
        transfer = createSessionFileNativeTransferBoundary();
        const serverIdentityId = 'srv_file_preview_source';
        const boundary = await createExternalActionAccountHttpBoundary({
            serverUrl: 'https://session-file-views.test', serverIdentityId,
            accountId: 'alice', machineId: 'm1', actionId: 'daemon.filesystem.download', tokenEpoch: 0,
            execute: (input, { target }) => {
                if (target.kind !== 'machine') throw new Error('Expected a preview Machine');
                if (downloadFailure) return downloadFailure;
                return transfer.rpc({ targetId: target.machineId,
                    method: getActionSpec('daemon.filesystem.download').bindings!.rpcMethod!, payload: input });
            },
        });
        const machine = transferMachine({ id: 'm1', storageMode: 'plain', installationId: boundary.machine.installationId,
            installationPublicKey: boundary.machine.installationPublicKey, replacedByMachineId: null, access: boundary.machine.access });
        const row = { ...boundary.machine, operationProtocolCapabilities: machine.operationProtocolCapabilities,
            operationProtocolCapabilitiesRevision: machine.operationProtocolCapabilitiesRevision,
            daemonState: encodePlainMachineStoredContent(machine.daemonState) };
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', machine, serverIdentityId,
            credentials: { token: `e30.${Buffer.from(JSON.stringify({ sub: 'alice', provenance: { v: 1, kind: 'account', authority: 'present_user' }, tokenEpoch: 0 })).toString('base64url')}.signature` },
            machineCarrierOrigin: transfer.origin, rpc: transfer.rpc, request: async (url, init) => {
                const parsed = new URL(String(url));
                if (interruptTransfer && parsed.origin === transfer.origin && parsed.pathname.endsWith('/chunks/0')) {
                    return new Response('Interrupted image transfer', { status: 503 });
                }
                if (parsed.pathname === '/v1/machines') return Response.json([row]);
                if (parsed.pathname === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
                    id => id === row.id ? row : null);
                if (parsed.pathname === '/v1/machines/m1') return Response.json({ machine: row });
                if (parsed.pathname.startsWith('/v1/actions/')) {
                    const response = await boundary.handle(parsed, init);
                    if (response) return response;
                }
                return transfer.request(url, init);
            } });
        fixture.storage.getState().applySettingsLocal({
            filesImagePreviewCacheMaxEntries: 10, filesImagePreviewCacheMaxTotalBytes: 1_000_000, filesImagePreviewMaxBytes: 1_000_000,
        });
    });
    afterEach(async () => { await fixture.dispose(); });

    it.each([
        { kind: 'workspace', cacheKey: null },
        { kind: 'workspace', cacheKey: 'stage-retry-sha' },
        { kind: 'session', cacheKey: null },
    ] as const)('retries a failed $kind byte read with key $cacheKey and saves the shown picture', async ({ kind, cacheKey }) => {
        const { MediaStage } = await import('./stage/MediaStage');
        interruptTransfer = true;
        fixture.storage.getState().applySettingsLocal({ filesImagePreviewCacheMaxEntries: 0 });
        const source = kind === 'workspace'
            ? { kind, scope: fixture.scope, filePath: 'stage-retry.png' }
            : { kind, sessionId: fixture.session.id, filePath: '.happier/uploads/messages/m1/stage-retry.png' };
        const screen = await renderScreen(fixture.wrap(React.createElement(MediaStage, {
            initialIndex: 0, onClose: () => {}, items: [{ kind: 'image', title: 'stage-retry.png',
                source: { enabled: true, source, cacheKey, mimeType: 'image/png', sizeBytes: 3 } }],
        })));
        let shownUri: string | undefined;
        try {
            await vi.waitFor(() => expect(screen.findByTestId('media-stage-retry')).toBeTruthy());
            expect(screen.findByTestId('media-stage-save')).toBeFalsy();
            interruptTransfer = false;
            await act(async () => screen.findByTestId('media-stage-retry')!.props.onPress());
            await vi.waitFor(() => expect(screen.findByTestId('media-stage-image')).toBeTruthy());
            shownUri = screen.findByTestId('media-stage-image')!.props.source.uri;
            expect(files.get(shownUri!)?.chunks.flatMap(chunk => [...chunk])).toEqual([97, 98, 99]);
            await act(async () => screen.findByTestId('media-stage-image')!.props.onLoad({ source: { width: 100, height: 60 } }));
            expect(screen.findByTestId('media-stage-save')).toBeTruthy();
            await act(async () => screen.findByTestId('media-stage-save')!.props.onPress());
            await vi.waitFor(() => expect(handoffs.shares).toEqual([[97, 98, 99]]));
            expect(handoffs.copies).toEqual([shownUri]);
            expect(files.get(shownUri!)?.exists).toBe(true);
            // One current picture owner, not a second unkeyed read for flight/Save.
            expect(transfer.prepares).toHaveLength(2);
        } finally { await screen.unmount(); }
        if (shownUri) expect(files.get(shownUri)?.exists).toBe(false);
    });

    it.each([true, false])('retains the size-limit reason when size is known before transfer: %s', async (knownSize) => {
        const hook = await renderHook(() => useFilePreviewSource({ enabled: true,
            source: { kind: 'workspace', scope: fixture.scope, filePath: 'too-large.png' },
            maxBytes: 2, ...(knownSize ? { sizeBytes: 3 } : {}),
        }));
        try {
            await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'error', errorCode: 'too_large' }));
            expect(buildImageCompareModel({ changeKind: 'added', before: { status: 'disabled' },
                after: projectImageComparePreview(hook.getCurrent()) }).after).toEqual({
                kind: 'unavailable', reason: { kind: 'tooLarge', sizeBytes: null },
            });
        } finally { await hook.unmount(); }
    });

    it('reports the unsupported owner verdict without reading bytes', async () => {
        const bytes = new Uint8Array([1]);
        const hook = await renderHook(() => useFilePreviewSource({ enabled: true,
            source: { kind: 'bytes', name: 'archive.zip', bytes },
            maxBytes: 0,
        }));
        try {
            await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'error', errorCode: 'unsupported' }));
            expect(transfer.prepares).toEqual([]);
            expect(files.size).toBe(0);
        } finally { await hook.unmount(); }
    });

    it.each([
        { code: 'not_found', reason: { kind: 'missing' } },
        { code: 'machine_carrier_transport_failed', reason: { kind: 'loadFailed', error: 'File does not exist' } },
        { code: undefined, reason: { kind: 'loadFailed', error: 'File does not exist' } },
    ])('preserves the owner failure $code through the preview and comparison projection', async ({ code, reason }) => {
        // The Machine Action response is a genuine external boundary. Identical messages must not classify the cause.
        downloadFailure = { success: false, status: 'failed', error: 'File does not exist', ...(code ? { errorCode: code } : {}) };
        const hook = await renderHook(({ enabled }: { enabled: boolean }) => useFilePreviewSource({ enabled,
            source: { kind: 'workspace', scope: fixture.scope, filePath: 'failed.png' }, cacheKey: 'failed-revision',
        }), { initialProps: { enabled: true } });
        try {
            await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'error', errorCode: code ?? null }));
            expect(buildImageCompareModel({ changeKind: 'added', before: { status: 'disabled' },
                after: projectImageComparePreview(hook.getCurrent()) }).after).toEqual({ kind: 'unavailable', reason });
            await hook.rerender({ enabled: false });
            expect(hook.getCurrent()).toEqual({ status: 'disabled', uri: null, error: null });
        } finally { await hook.unmount(); }
    });

    it('loads a workspace preview without a session', async () => {
        const hook = await renderHook(() => useFilePreviewSource({
            enabled: true, source: { kind: 'workspace', scope: fixture.scope, filePath: 'workspace.png' },
            mimeType: 'image/png', sizeBytes: 3,
        }));
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('loaded'));
        expect(files.get(hook.getCurrent().uri!)?.chunks.flatMap(chunk => [...chunk])).toEqual([97, 98, 99]);
        await hook.unmount();
    });

    it.each([false, true])('settles two added-image Review consumers when one leaves an in-flight read (failure: %s)', async (failed) => {
        interruptTransfer = failed;
        const gate = transfer.deferNextOpen();
        const input = { enabled: true, scope: fixture.scope, filePath: `added-compare-${failed}.png`,
            source: { kind: 'workingTree' as const, changeKind: 'added', area: 'both' as const, signature: `added-compare-${failed}` } };
        const first = await renderHook(() => useImageCompare(input));
        const second = await renderHook(() => useImageCompare({ ...input, scope: { ...fixture.scope } }));
        try {
            await vi.waitFor(() => expect(transfer.httpRequests.some(request => request.url.endsWith('/open'))).toBe(true));
            expect(transfer.prepares).toHaveLength(1);
            expect(second.getCurrent().before).toEqual({ kind: 'added' });
            expect(second.getCurrent().after).toEqual({ kind: 'noPreview', reason: 'loading' });
            const pendingRead = transfer.httpRequests.find(request => request.url.endsWith('/open'))!;
            await first.unmount();
            expect(pendingRead.signal?.aborted).toBe(false);
            await act(async () => { gate.resolve(); });
            if (failed) {
                await vi.waitFor(() => expect(second.getCurrent().after).toMatchObject({ kind: 'unavailable', reason: { kind: 'loadFailed' } }));
                expect(second.getCurrent().gallery).toHaveLength(0);
            } else {
                await vi.waitFor(() => expect(second.getCurrent().after.kind).toBe('present'));
                const after = second.getCurrent().after;
                if (after.kind !== 'present') throw new Error('Expected a settled Review image');
                expect(files.get(after.uri)?.chunks.flatMap(chunk => [...chunk])).toEqual([97, 98, 99]);
                expect(second.getCurrent().gallery).toHaveLength(1);
            }
            expect(transfer.prepares).toHaveLength(1);
        } finally {
            gate.resolve();
            await first.unmount();
            await second.unmount();
        }
    });

    it('reports the shared transfer progress while a workspace preview downloads', async () => {
        transfer.setPayload(new Uint8Array([1, 2, 3, 4, 5]), 'clip.mp4');
        const held = transfer.deferNextComplete();
        const input = {
            enabled: true, source: { kind: 'workspace' as const, scope: fixture.scope, filePath: 'clip.mp4' },
            mimeType: 'video/mp4', sizeBytes: 5, cacheKey: 'clip-revision',
        };
        const first = await renderHook(() => useFilePreviewSource(input));
        await vi.waitFor(() => expect(first.getCurrent()).toMatchObject({ status: 'loading', progress: { receivedBytes: 5, totalBytes: 5 } }));
        // A second consumer of the same fill (the stage over the body) reads the one transfer's bytes.
        const joined = await renderHook(() => useFilePreviewSource(input));
        expect(joined.getCurrent()).toMatchObject({ status: 'loading', progress: { receivedBytes: 5, totalBytes: 5 } });
        held.resolve();
        await vi.waitFor(() => expect(first.getCurrent().status).toBe('loaded'));
        expect(transfer.prepares).toHaveLength(1);
        await joined.unmount();
        await first.unmount();
    });

    it('does not take ownership of pre-materialized URIs', async () => {
        const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        const hook = await renderHook(() => useFilePreviewSource({ enabled: true, source: { kind: 'uri', uri: 'blob:plugin-owned' } }));
        expect(hook.getCurrent()).toMatchObject({ status: 'loaded', uri: 'blob:plugin-owned', error: null });
        await hook.unmount();
        expect(revoke).not.toHaveBeenCalled();
        expect(files.size).toBe(0);
    });

    it('observes cached thumbnails without materializing bytes and follows a later shared fill', async () => {
        const input = { enabled: true, source: { kind: 'bytes' as const, bytes: new Uint8Array([1, 2, 3]), name: 'thumbnail.png' },
            mimeType: 'image/png', cacheScopeId: 'thumbnail-gallery', cacheKey: 'revision' };
        const thumbnail = await renderHook(() => useFilePreviewSource({ ...input, cacheOnly: true }));
        expect(files.size).toBe(0);
        expect(thumbnail.getCurrent().status).toBe('disabled');
        const picture = await renderHook(() => useFilePreviewSource(input));
        await vi.waitFor(() => expect(picture.getCurrent().status).toBe('loaded'));
        await vi.waitFor(() => expect(thumbnail.getCurrent().uri).toBe(picture.getCurrent().uri));
        const uri = picture.getCurrent().uri!;
        fixture.storage.getState().applySettingsLocal({ filesImagePreviewCacheMaxEntries: 0 });
        await picture.unmount();
        expect(files.get(uri)?.exists).toBe(true);
        await thumbnail.unmount();
        expect(files.get(uri)?.exists).toBe(false);
    });

    it('releases an in-memory bytes source when its consumer unmounts', async () => {
        const bytes = new Uint8Array([1, 2, 3]);
        const hook = await renderHook(() => useFilePreviewSource({
            enabled: true, source: { kind: 'bytes', bytes, name: 'bytes.png' }, mimeType: 'image/png',
        }));
        await hook.unmount();
        await vi.waitFor(() => expect([...files.values()].every(file => !file.exists)).toBe(true));
        expect(transfer.prepares).toEqual([]);
    });

    it('never exposes a released URI when the same source is enabled again', async () => {
        fixture.storage.getState().applySettingsLocal({ filesImagePreviewCacheMaxEntries: 0 });
        const bytes = new Uint8Array([1, 2, 3]);
        const loaded: Array<{ uri: string; exists: boolean }> = [];
        const hook = await renderHook(({ enabled }: { enabled: boolean }) => {
            const state = useFilePreviewSource({ enabled, source: { kind: 'bytes', bytes, name: 'toggle.png' }, mimeType: 'image/png' });
            if (state.status === 'loaded') loaded.push({ uri: state.uri, exists: files.get(state.uri)?.exists === true });
            return state;
        }, { initialProps: { enabled: true } });
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('loaded'));
        const first = hook.getCurrent().uri!;
        await hook.rerender({ enabled: false });
        expect(files.get(first)?.exists).toBe(false);
        loaded.length = 0;
        await hook.rerender({ enabled: true });
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('loaded'));
        expect(loaded.every(value => value.exists)).toBe(true);
        expect(hook.getCurrent().uri).not.toBe(first);
        await hook.unmount();
    });

    it('waits for the session workspace target and retries once it becomes available', async () => {
        // Not hydrated yet: neither the Session nor this Home's list row carries the workspace. (An
        // equal-revision `metadata: null` apply is not a newer fact, and the scoped row keeps its own copy.)
        fixture.storage.setState((state) => {
            const { [fixture.session.id]: _hydratedRow, ...rows } = state.sessionListRowsByServerId[fixture.scope.serverId] ?? {};
            return {
                sessions: { ...state.sessions, [fixture.session.id]: { ...state.sessions[fixture.session.id]!, metadata: null } },
                sessionListRowsByServerId: { ...state.sessionListRowsByServerId, [fixture.scope.serverId]: rows },
            };
        });
        const hook = await renderHook(() => useFilePreviewSource({
            source: { kind: 'session', sessionId: fixture.session.id, filePath: '.happier/uploads/messages/m1/file.png' },
            enabled: true, cacheKey: 'sha-1', mimeType: 'image/png', sizeBytes: 3,
        }));
        expect(hook.getCurrent()).toEqual({ status: 'loading', uri: null, error: null });
        expect(transfer.prepares).toEqual([]);

        await act(async () => fixture.storage.getState().applySessions([fixture.session]));
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'loaded', error: null }));
        expect(transfer.prepares).toHaveLength(1);
        expect(transfer.prepares[0]).toMatchObject({
            targetId: fixture.scope.machineId,
            method: getActionSpec('daemon.filesystem.download').bindings?.rpcMethod,
            payload: { rootPath: '/repo',
                path: '/repo/.happier/uploads/messages/m1/file.png', asZip: false },
        });
        expect(hook.getCurrent().uri?.startsWith('data:')).toBe(false);
        const file = files.get(hook.getCurrent().uri!);
        expect(file?.chunks.flatMap((chunk) => [...chunk])).toEqual([97, 98, 99]);
        await hook.unmount();
    });

    it('loads an opaque staged composer image through the incumbent preview cache without resolving a session workspace path', async () => {
        const handle: ComposerContentHandleV1 = {
            v: 1, id: 'stage_42', executionTarget: { serverId: fixture.scope.serverId, machineId: fixture.scope.machineId },
            owner: { pluginId: 'acme.images', localId: 'image' }, mediaKind: 'image',
            mimeType: 'image/png', name: 'incident.png', sizeBytes: 3, sha256: 'a'.repeat(64),
        };
        const { projectComposerAttachmentRowItems } = await import('@/components/sessions/composer/composerAttachmentProjection');
        const { Modal } = await import('@/modal');
        const attachment = {
            v: 1 as const, instanceId: 'image-42', attachment: handle.owner, key: '42', value: {},
            presentation: { label: 'Incident image', typeLabel: 'Image' }, availability: { status: 'ready' as const },
            content: { kind: 'stagedMedia' as const, handle },
        };
        const row = projectComposerAttachmentRowItems({ attachments: [attachment], entriesById: {
            'acme.images/image': { id: 'acme.images/image', pluginId: 'acme.images', identity: handle.owner,
                occurrenceId: 'images-current', definition: { id: 'image', title: 'Image', icon: 'file', cardinality: 'many',
                    valueSchema: { type: 'object' }, display: { kind: 'media', media: 'image' },
                    preview: { kind: 'host', presentation: 'image' } } },
        } })[0]!;
        row.onPress?.();
        const openedStage = vi.mocked(Modal.show).mock.lastCall?.[0];
        const stageProps = openedStage && 'props' in openedStage ? openedStage.props : undefined;
        expect(stageProps).toMatchObject({ items: [{ kind: 'image', alphaCapable: true,
            source: { source: { kind: 'composerStage', handle } } }] });
        fixture.storage.getState().applySessions([{ ...fixture.session, metadata: null }]);
        const hook = await renderHook(({ staged }: { staged: ComposerContentHandleV1 }) => useFilePreviewSource({
            enabled: true, source: { kind: 'composerStage', handle: staged },
        }), { initialProps: { staged: handle } });
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('loaded'));
        expect(transfer.prepares.map((request) => request.payload)).toEqual([{
            t: 'composer_media_stage_inspect_v1', handle, offset: 0, maxBytes: 3,
        }]);
        expect(files.get(hook.getCurrent().uri!)?.chunks.flatMap((chunk) => [...chunk])).toEqual([97, 98, 99]);
        // A replacement opaque stage is cancelled at the real HTTP boundary,
        // not inferred from a settled request's already-disposed signal.
        const gate = transfer.deferNextOpen();
        await hook.rerender({ staged: { ...handle, id: 'stage_43', sha256: 'b'.repeat(64) } });
        await vi.waitFor(() => expect(transfer.prepares).toHaveLength(2));
        await vi.waitFor(() => expect(transfer.httpRequests.filter((request) => request.url.endsWith('/open'))).toHaveLength(2));
        const pendingRequest = transfer.httpRequests.at(-1)!;
        await hook.unmount();
        expect(pendingRequest.signal?.aborted).toBe(true);
        gate.resolve();
        await vi.waitFor(() => expect(transfer.activeNativeTunnelIds).toEqual([]));
    });

    it('cleans up a preview source when its transfer resolves after unmount', async () => {
        const gate = transfer.deferNextOpen();
        const hook = await renderHook(() => useFilePreviewSource({
            source: { kind: 'session', sessionId: fixture.session.id, filePath: '.happier/uploads/messages/m1/file.png' },
            enabled: true, cacheKey: null, mimeType: 'image/png', sizeBytes: 3,
        }));
        await vi.waitFor(() => expect(transfer.httpRequests.some((request) => request.url.endsWith('/open'))).toBe(true));
        expect([...files.values()].some((file) => file.exists)).toBe(true);
        await hook.unmount();
        expect(transfer.httpRequests[0]?.signal?.aborted).toBe(true);
        gate.resolve();
        await vi.waitFor(() => expect([...files.values()].every((file) => !file.exists)).toBe(true));
        // Outcome, not call counts: every sink was closed once and nothing is left in the cache.
        expect([...files.values()].every((file) => file.closed === 1 && !file.exists)).toBe(true);
        await vi.waitFor(() => expect(transfer.activeNativeTunnelIds).toEqual([]));
    });

    it('keeps one in-flight transfer for equivalent workspace scope objects and publishes its URI once', async () => {
        const gate = transfer.deferNextOpen();
        const hook = await renderHook(({ workspaceScope }: { workspaceScope: typeof fixture.scope }) => useFilePreviewSource({
            source: { kind: 'workspace', scope: workspaceScope, filePath: '.happier/uploads/messages/m1/file.png' },
            enabled: true, cacheKey: null, mimeType: 'image/png', sizeBytes: 3,
            cacheScopeId: 'stable-scope',
        }), { initialProps: { workspaceScope: { ...fixture.scope } } });
        await vi.waitFor(() => expect(transfer.prepares).toHaveLength(1));
        await hook.rerender({ workspaceScope: { ...fixture.scope } });
        expect(transfer.prepares).toHaveLength(1);
        gate.resolve();
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('loaded'));
        const uri = hook.getCurrent().uri!;
        expect(files.get(uri)?.exists).toBe(true);
        await hook.unmount();
        await vi.waitFor(() => expect(files.get(uri)?.exists).toBe(false));
        expect(files.get(uri)?.closed).toBe(1);
    });

    it('shares one URI and in-flight transfer between two mounted consumers of the same cache identity', async () => {
        const gate = transfer.deferNextOpen();
        const input = {
            source: { kind: 'workspace' as const, scope: fixture.scope, filePath: 'shared-image.png' }, enabled: true,
            cacheKey: 'two-consumers', mimeType: 'image/png', sizeBytes: 3,
            cacheScopeId: 'shared-workspace',
        };
        const first = await renderHook(() => useFilePreviewSource(input));
        const second = await renderHook(() => useFilePreviewSource(input));
        await vi.waitFor(() => expect(transfer.prepares.length).toBeGreaterThan(0));
        gate.resolve();
        await vi.waitFor(() => expect(first.getCurrent().status).toBe('loaded'));
        await vi.waitFor(() => expect(second.getCurrent().status).toBe('loaded'));
        expect(second.getCurrent().uri).toBe(first.getCurrent().uri);
        expect(transfer.prepares).toHaveLength(1);
        const uri = first.getCurrent().uri!;
        await first.unmount();
        expect(files.get(uri)?.exists).toBe(true);
        await second.unmount();
    });

    it('releases the prior uncached source when the logical file identity changes', async () => {
        const hook = await renderHook(({ filePath }: { filePath: string }) => useFilePreviewSource({
            source: { kind: 'workspace', scope: fixture.scope, filePath }, enabled: true, cacheKey: null, mimeType: 'image/png',
            cacheScopeId: 'identity-scope',
        }), { initialProps: { filePath: '.happier/uploads/messages/m1/first.png' } });
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('loaded'));
        const firstUri = hook.getCurrent().uri!;
        transfer.setPayload(new Uint8Array([97, 98, 99, 100]), 'second.png');
        await hook.rerender({ filePath: '.happier/uploads/messages/m1/second.png' });
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('loaded'));
        const secondUri = hook.getCurrent().uri!;
        expect(transfer.prepares).toHaveLength(2);
        expect(secondUri).not.toBe(firstUri);
        expect(files.get(firstUri)?.exists).toBe(false);
        expect(files.get(firstUri)?.closed).toBe(1);
        expect(files.get(secondUri)?.chunks.flatMap((chunk) => [...chunk])).toEqual([97, 98, 99, 100]);
        await hook.unmount();
        await vi.waitFor(() => expect(files.get(secondUri)?.exists).toBe(false));
        expect(files.get(secondUri)?.closed).toBe(1);
    });
});
