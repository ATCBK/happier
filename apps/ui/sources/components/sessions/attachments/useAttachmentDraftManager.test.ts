import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook } from '@/dev/testkit';

vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

import { useAttachmentDraftManager } from './useAttachmentDraftManager';
import type { AttachmentDraft } from './attachmentDraftModel';

describe('useAttachmentDraftManager', () => {
    it('keeps the manager object and its callbacks referentially stable across parent re-renders', async () => {
        // The manager is consumed by memoized composer/transcript surfaces; a fresh object per
        // render cascades into per-commit re-renders of every visible transcript row.
        const hook = await renderHook(() => useAttachmentDraftManager({
            enabled: true,
            maxFileBytes: 1024,
        }));

        const first = hook.getCurrent();
        await hook.rerender();
        const second = hook.getCurrent();

        expect(second).toBe(first);
        expect(second.replaceDrafts).toBe(first.replaceDrafts);
        expect(second.removeDraft).toBe(first.removeDraft);
        expect(second.clearDrafts).toBe(first.clearDrafts);
        expect(second.removeSubmittedDrafts).toBe(first.removeSubmittedDrafts);
        expect(second.addWebFiles).toBe(first.addWebFiles);
        expect(second.addPickedAttachments).toBe(first.addPickedAttachments);
        expect(second.applyDraftPatch).toBe(first.applyDraftPatch);
        expect(second.getDraftsSnapshot).toBe(first.getDraftsSnapshot);
        expect(second.getDraftRevisionSnapshot).toBe(first.getDraftRevisionSnapshot);
    });

    it('returns a new manager identity when drafts change', async () => {
        const hook = await renderHook(() => useAttachmentDraftManager({
            enabled: true,
            maxFileBytes: 1024,
        }));

        const before = hook.getCurrent();
        await act(async () => {
            before.replaceDrafts([{
                id: 'draft-1',
                source: { kind: 'memory', name: 'a.txt', bytes: new Uint8Array([1]) },
                status: 'pending',
            } as never]);
        });

        const after = hook.getCurrent();
        expect(after).not.toBe(before);
        expect(after.drafts).toHaveLength(1);
        expect(after.hasSendableAttachments).toBe(true);
    });

    it('advances the draft revision for an explicit clear even when drafts are already empty', async () => {
        const hook = await renderHook(() => useAttachmentDraftManager({
            enabled: true,
            maxFileBytes: 1024,
        }));

        const before = hook.getCurrent().getDraftRevisionSnapshot();
        await act(async () => {
            hook.getCurrent().clearDrafts();
        });

        expect(hook.getCurrent().drafts).toEqual([]);
        expect(hook.getCurrent().getDraftRevisionSnapshot()).toBe(before + 1);
    });

    it('publishes the current process-local snapshot synchronously with each mutation', async () => {
        const hook = await renderHook(() => useAttachmentDraftManager({
            enabled: true,
            maxFileBytes: 1024,
        }));

        const manager = hook.getCurrent();
        const nextDraft = {
            id: 'draft-immediate',
            source: { kind: 'memory', name: 'instant.txt', bytes: new Uint8Array([1]) },
            status: 'pending',
        } as const;

        await act(async () => {
            manager.replaceDrafts([nextDraft]);
            expect(manager.getDraftsSnapshot()).toEqual([nextDraft]);

            manager.clearDrafts();
            expect(manager.getDraftsSnapshot()).toEqual([]);
        });
    });

    it('removes unchanged submitted sources after upload while preserving new drafts and same-ID source replacements', async () => {
        const replaced: AttachmentDraft = { id: 'replaced', status: 'pending',
            source: { kind: 'memory', name: 'picture.png', bytes: new Uint8Array([1]) } };
        const uploaded: AttachmentDraft = { id: 'uploaded', status: 'pending',
            source: { kind: 'native', name: 'notes.txt', uri: 'file:///notes.txt', sizeBytes: 1 } };
        const hook = await renderHook(() => useAttachmentDraftManager({ enabled: true, maxFileBytes: 1024,
            initialDrafts: [replaced, uploaded] }));
        const manager = hook.getCurrent();
        const submitted = manager.getDraftsSnapshot();
        const replacement: AttachmentDraft = { ...replaced,
            source: { kind: 'memory', name: 'picture.png', bytes: new Uint8Array([2]) } };
        const additional: AttachmentDraft = { id: 'additional', status: 'pending',
            source: { kind: 'memory', name: 'later.txt', bytes: new Uint8Array([3]) } };
        await act(async () => {
            manager.applyDraftPatch(uploaded.id, { status: 'uploaded', uploadedPath: 'uploaded/notes.txt',
                uploadProgress: { uploadedBytes: 1, totalBytes: 1 } });
            manager.replaceDrafts([replacement, manager.getDraftsSnapshot()[1]!, additional]);
            const revision = manager.getDraftRevisionSnapshot();
            const remaining = manager.removeSubmittedDrafts(submitted);
            expect(remaining).toEqual([replacement, additional]);
            expect(manager.getDraftsSnapshot()).toBe(remaining);
            expect(manager.getDraftRevisionSnapshot()).toBe(revision + 1);
        });
        expect(hook.getCurrent().drafts).toEqual([replacement, additional]);
    });

    it('does not invalidate a newer source snapshot when no submitted draft remains', async () => {
        const captured: AttachmentDraft = { id: 'same-id', status: 'pending',
            source: { kind: 'memory', name: 'a.txt', bytes: new Uint8Array([1]) } };
        const replacement: AttachmentDraft = { ...captured, source: { ...captured.source } };
        const hook = await renderHook(() => useAttachmentDraftManager({ enabled: true, maxFileBytes: 1024,
            initialDrafts: [replacement] }));
        const manager = hook.getCurrent();
        const before = manager.getDraftsSnapshot();
        const revision = manager.getDraftRevisionSnapshot();
        await act(async () => {
            expect(manager.removeSubmittedDrafts([captured])).toBe(before);
        });
        expect(manager.getDraftRevisionSnapshot()).toBe(revision);
        expect(hook.getCurrent().drafts).toEqual([replacement]);
    });

    it('refuses a late upload checkpoint for a replaced source while retaining explicit two-argument patches', async () => {
        const captured: AttachmentDraft = { id: 'source-choice', status: 'pending',
            source: { kind: 'memory', name: 'a.txt', bytes: new Uint8Array([1]) } };
        const replacement: AttachmentDraft = { ...captured,
            source: { kind: 'memory', name: 'b.txt', bytes: new Uint8Array([2]) } };
        const hook = await renderHook(() => useAttachmentDraftManager({ enabled: true, maxFileBytes: 1024,
            initialDrafts: [captured] }));
        const manager = hook.getCurrent();
        await act(async () => {
            manager.applyDraftPatch(captured.id, { status: 'uploading' }, captured.source);
            expect(manager.getDraftsSnapshot()[0]?.status).toBe('uploading');
            manager.replaceDrafts([replacement]);
            const revision = manager.getDraftRevisionSnapshot();
            manager.applyDraftPatch(captured.id, { status: 'uploaded', uploadedPath: 'old-source.txt',
                uploadedSizeBytes: 1, sha256: 'old-source-digest' }, captured.source);
            expect(manager.getDraftsSnapshot()).toEqual([replacement]);
            expect(manager.getDraftRevisionSnapshot()).toBe(revision);
            manager.applyDraftPatch(replacement.id, { status: 'error', error: 'explicit edit' });
            expect(manager.getDraftsSnapshot()).toEqual([{ ...replacement, status: 'error', error: 'explicit edit' }]);
        });
    });
});
