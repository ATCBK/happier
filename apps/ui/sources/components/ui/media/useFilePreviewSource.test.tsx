import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { ComposerContentHandleV1 } from '@happier-dev/protocol';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

import { renderHook } from '@/dev/testkit';
import { createSessionFileNativeTransferBoundary } from '@/components/sessions/files/sessionFileNativeTransferTestkit';
import { createSessionFilesViewFixture, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { useFilePreviewSource } from './useFilePreviewSource';

const files = vi.hoisted(() => new Map<string, { exists: boolean; chunks: Uint8Array[]; closed: number; deletes: number }>());
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
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
    beforeAll(prepareSessionFilesViewTestkit);
    beforeEach(async () => {
        files.clear();
        transfer = createSessionFileNativeTransferBoundary();
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', machineCarrierOrigin: transfer.origin, rpc: transfer.rpc, request: transfer.request });
        fixture.storage.getState().applySettingsLocal({
            filesImagePreviewCacheMaxEntries: 10, filesImagePreviewCacheMaxTotalBytes: 1_000_000, filesImagePreviewMaxBytes: 1_000_000,
        });
    });
    afterEach(async () => { await fixture.dispose(); });

    it('loads a workspace preview without a session', async () => {
        const hook = await renderHook(() => useFilePreviewSource({
            enabled: true, source: { kind: 'workspace', scope: fixture.scope, filePath: 'workspace.png' },
            mimeType: 'image/png', sizeBytes: 3,
        }));
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('loaded'));
        expect(files.get(hook.getCurrent().uri!)?.chunks.flatMap(chunk => [...chunk])).toEqual([97, 98, 99]);
        await hook.unmount();
    });

    it('does not take ownership of pre-materialized URIs', async () => {
        const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        const hook = await renderHook(() => useFilePreviewSource({ enabled: true, source: { kind: 'uri', uri: 'blob:plugin-owned' } }));
        expect(hook.getCurrent()).toMatchObject({ status: 'loaded', uri: 'blob:plugin-owned', error: null });
        await hook.unmount();
        expect(revoke).not.toHaveBeenCalled();
        expect(files.size).toBe(0);
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
            payload: { input: { rootPath: '/repo',
                path: '/repo/.happier/uploads/messages/m1/file.png', asZip: false } },
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
