import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alert: () => { },
        },
    }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'draft-1',
}));

// Load the real transfer graph during collection, outside an individual hook's timing budget.
await import('./uploadAttachmentDraftsToSession');

describe('useAttachmentDraftManager (attachments.uploads)', () => {
    it.each([true, false])('starts folder uploads at intake and checkpoints success=%s', async (success) => {
        const { createTransferRecipientKeyPair } = await import('@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption');
        const recipient = createTransferRecipientKeyPair();
        const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
        let finish: ((value: unknown) => void) | undefined;
        const finalizing = new Promise<unknown>(resolve => { finish = resolve; });
        let path = '';
        const call = vi.fn(async (method: string, request: unknown): Promise<unknown> => {
            if (method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT) {
                path = `.uploads/messages/m1/${(request as { relativePath: string }).relativePath}`;
                return { success: true, uploadId: 'u1', chunkSizeBytes: 5, recipientPublicKeyBase64: recipient.recipientPublicKeyBase64 };
            }
            if (method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE) {
                const result = await finalizing as Record<string, unknown>;
                return { ...result, path };
            }
            return { success: true };
        });
        const { useAttachmentDraftManager } = await import('./useAttachmentDraftManager');
        const hook = await renderHook(() => useAttachmentDraftManager({ enabled: true, maxFileBytes: 3,
            eagerUpload: { sessionId: 's1', config: { uploadLocation: 'workspace', workspaceRelativeDir: '.uploads',
                vcsIgnoreStrategy: 'none', vcsIgnoreWritesEnabled: false, maxFileBytes: 3 },
                transferContext: { kind: 'sessionBound', sessionId: 's1',
                    call: async <T,>(method: string, request: unknown): Promise<T> => await call(method, request) as T } },
        }));
        await act(async () => { hook.getCurrent().addWebFiles([], { sources: [{ kind: 'folder', name: 'project',
            mimeType: 'inode/directory', entries: [{ relativePath: 'a.txt',
                source: { kind: 'memory', name: 'a.txt', bytes: new Uint8Array(3) } }] }] }); });
        await vi.waitFor(() => expect(call.mock.calls.some(([method]) => method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE)).toBe(true));
        expect(hook.getCurrent().drafts[0]?.status).toBe('uploading');
        expect(hook.getCurrent().drafts[0]?.uploadedPath).toBeUndefined();
        await act(async () => { finish?.(success ? { success: true, path: '.uploads/messages/m1/draft-1/project/a.txt', sizeBytes: 3,
            sha256: 'sha', attachmentHandle: { v: 1, sessionId: 's1', id: 'handle-a' } }
            : { success: false, error: 'transport diagnostic', errorCode: 'permission_denied' }); });
        if (success) {
            await vi.waitFor(() => expect(hook.getCurrent().drafts[0]).toMatchObject({ status: 'uploaded',
                uploadedPath: '.uploads/messages/m1/draft-1/project', uploadedMimeType: 'inode/directory' }));
        } else {
            await vi.waitFor(() => expect(hook.getCurrent().drafts[0]).toMatchObject({ status: 'error',
                error: 'files.transfers.uploadFailed · errors.permissionDenied' }));
            const manager = hook.getCurrent();
            expect(manager.getSendableDraftsSnapshot()).toEqual([]);
            expect(manager.hasSendableAttachments).toBe(false);
            const { prepareComposerSubmissionSnapshot } = await import('@/components/sessions/composer/composerSubmissionCoordinator');
            const token = '[project](happier-ref:attachment:draft-1)';
            expect(prepareComposerSubmissionSnapshot({ text: `Read ${token}`, attachments: [], references: [{
                kind: 'happier.attachment', ref: 'attachment:draft-1', token, start: 5, end: 5 + token.length,
            }] }, manager.getSendableDraftsSnapshot().map(draft => draft.id))).toMatchObject({ text: 'Read ', references: [] });
        }
    });
    it('adds one folder receipt and tray item with per-file size validation', async () => {
        const { useAttachmentDraftManager } = await import('./useAttachmentDraftManager');
        const hook = await renderHook(() => useAttachmentDraftManager({ enabled: true, maxFileBytes: 3 }));
        let receipts: unknown;
        act(() => {
            receipts = hook.getCurrent().addWebFiles([], { sources: [{
                kind: 'folder', name: 'project', mimeType: 'inode/directory', entries: [
                    { relativePath: 'a.txt', source: { kind: 'memory', name: 'a.txt', bytes: new Uint8Array(3) } },
                    { relativePath: 'nested/b.txt', source: { kind: 'memory', name: 'b.txt', bytes: new Uint8Array(3) } },
                ],
            }] });
        });
        expect(receipts).toEqual([expect.objectContaining({ id: 'draft-1', status: 'pending' })]);
        expect(hook.getCurrent().agentInputAttachments).toEqual([expect.objectContaining({ key: 'draft-1', label: 'project' })]);
    });
    it('keeps onRemove defined while uploading so UI can disable it (not hide it)', async () => {
        (globalThis as any).URL ??= {};
        (globalThis as any).URL.createObjectURL ??= () => 'blob:test';
        (globalThis as any).URL.revokeObjectURL ??= () => { };

        const { useAttachmentDraftManager } = await import('./useAttachmentDraftManager');
        const hook = await renderHook(() => useAttachmentDraftManager({ enabled: true, maxFileBytes: 25 * 1024 * 1024 }));
        const manager = () => hook.getCurrent();

        const file = typeof File === 'function'
            ? new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' })
            : ({ name: 'image.png', size: 3, type: 'image/png', slice: () => new Blob([new Uint8Array([1, 2, 3])]) } as any);

        act(() => {
            manager().addWebFiles([file as any]);
        });

        expect(manager().drafts).toHaveLength(1);
        expect(manager().drafts[0]!.id).toBe('draft-1');

        act(() => {
            manager().applyDraftPatch('draft-1', { status: 'uploading' });
        });

        expect(manager().agentInputAttachments).toHaveLength(1);
        expect(manager().agentInputAttachments[0]!.status).toBe('uploading');
        expect(manager().agentInputAttachments[0]!.onRemove).toEqual(expect.any(Function));
    });

    it('skips web previews safely when URL globals are unavailable', async () => {
        const originalUrl = globalThis.URL;
        // @ts-expect-error test deletes URL to simulate missing browser global
        delete globalThis.URL;

        try {
            const { useAttachmentDraftManager } = await import('./useAttachmentDraftManager');
            const hook = await renderHook(() => useAttachmentDraftManager({ enabled: true, maxFileBytes: 25 * 1024 * 1024 }));
            const manager = () => hook.getCurrent();

            const file = typeof File === 'function'
                ? new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' })
                : ({ name: 'image.png', size: 3, type: 'image/png', slice: () => new Blob([new Uint8Array([1, 2, 3])]) } as File);

            expect(() => {
                act(() => {
                    manager().addWebFiles([file]);
                });
            }).not.toThrow();
            expect(manager().agentInputAttachments[0]?.preview).toBeUndefined();
        } finally {
            Object.defineProperty(globalThis, 'URL', {
                configurable: true,
                value: originalUrl,
            });
        }
    });

    it('uses in-memory image preview URIs for clipboard image drafts', async () => {
        const { useAttachmentDraftManager } = await import('./useAttachmentDraftManager');
        const hook = await renderHook(() => useAttachmentDraftManager({ enabled: true, maxFileBytes: 25 * 1024 * 1024 }));
        const manager = () => hook.getCurrent();

        act(() => {
            manager().addPickedAttachments([{
                kind: 'memory',
                name: 'pasted-image.png',
                bytes: new Uint8Array([1, 2, 3]),
                mimeType: 'image/png',
                previewUri: 'data:image/png;base64,AQID',
            } as any]);
        });

        expect(manager().agentInputAttachments[0]?.preview).toEqual({
            kind: 'image',
            uri: 'data:image/png;base64,AQID',
            mimeType: 'image/png',
        });
    });

    it('replaces attachment drafts from a failed handoff recovery snapshot', async () => {
        const { useAttachmentDraftManager } = await import('./useAttachmentDraftManager');
        const hook = await renderHook(() => useAttachmentDraftManager({ enabled: true, maxFileBytes: 25 * 1024 * 1024 }));
        const manager = () => hook.getCurrent();

        const restoredDraft = {
            id: 'restored-draft',
            source: {
                kind: 'memory',
                name: 'retry.txt',
                bytes: new Uint8Array([1, 2, 3]),
                mimeType: 'text/plain',
            },
            status: 'pending',
        } as const;

        expect(typeof manager().replaceDrafts).toBe('function');

        act(() => {
            manager().replaceDrafts?.([restoredDraft]);
        });

        expect(manager().drafts).toEqual([restoredDraft]);
        expect(manager().agentInputAttachments[0]?.label).toBe('retry.txt');
    });
});
