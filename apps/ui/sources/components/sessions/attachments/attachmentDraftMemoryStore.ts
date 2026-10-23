import { removeSubmittedAttachmentDrafts, type AttachmentDraft } from './attachmentDraftModel';

const attachmentDraftMemoryStore = new Map<string, readonly AttachmentDraft[]>();
const EMPTY_DRAFTS: readonly AttachmentDraft[] = Object.freeze([]);
type DraftChange = 'changed' | 'cleared';
// Moved from New Session: all mounted attachment consumers follow this one memory owner.
const listeners = new Set<Readonly<{ key: string; changed: (event: DraftChange) => void }>>();

function notify(key: string, event: DraftChange): void {
    for (const listener of [...listeners]) if (listener.key === key) listener.changed(event);
}

export function subscribeAttachmentDraftsForKey(key: string, changed: (event: DraftChange) => void): () => void {
    const listener = { key, changed };
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** Stable readonly snapshot for the mounted manager; public copy readers retain their API. */
export function getAttachmentDraftsSnapshotForKey(key: string): readonly AttachmentDraft[] {
    return attachmentDraftMemoryStore.get(key) ?? EMPTY_DRAFTS;
}

function copyAttachmentDrafts(drafts: readonly AttachmentDraft[]): AttachmentDraft[] {
    return drafts.map((draft) => ({
        ...draft,
        source: draft.source,
        uploadProgress: draft.uploadProgress ? { ...draft.uploadProgress } : undefined,
    }));
}

export function readAttachmentDraftsForKey(key: string): AttachmentDraft[] {
    const drafts = attachmentDraftMemoryStore.get(key);
    return drafts ? copyAttachmentDrafts(drafts) : [];
}

export function writeAttachmentDraftsForKey(key: string, drafts: readonly AttachmentDraft[]): void {
    const previous = getAttachmentDraftsSnapshotForKey(key);
    if (previous.length === drafts.length && previous.every((draft, index) => draft === drafts[index])) return;
    if (drafts.length === 0) {
        attachmentDraftMemoryStore.delete(key);
    } else {
        attachmentDraftMemoryStore.set(key, [...drafts]);
    }
    notify(key, 'changed');
}

export function settleAttachmentDraftsForKey(key: string, submitted: readonly AttachmentDraft[]): readonly AttachmentDraft[] {
    const remaining = removeSubmittedAttachmentDrafts(getAttachmentDraftsSnapshotForKey(key), submitted);
    writeAttachmentDraftsForKey(key, remaining);
    return remaining;
}

export function patchAttachmentDraftForKey(key: string, id: string, patch: Partial<Omit<AttachmentDraft, 'id' | 'source'>>, expectedSource?: AttachmentDraft['source']): void {
    const drafts = getAttachmentDraftsSnapshotForKey(key);
    if (!drafts.some(draft => draft.id === id && (!expectedSource || draft.source === expectedSource))) return;
    writeAttachmentDraftsForKey(key, drafts.map(draft => draft.id === id ? { ...draft, ...patch } : draft));
}

export function clearAttachmentDraftsForKey(key: string): void {
    attachmentDraftMemoryStore.delete(key);
    notify(key, 'cleared');
}

export function clearAttachmentDraftsForKeyPrefix(prefix: string): void {
    const keys = new Set([...attachmentDraftMemoryStore.keys(), ...[...listeners].map(listener => listener.key)]);
    for (const key of keys) {
        if (key.startsWith(prefix)) {
            attachmentDraftMemoryStore.delete(key);
            notify(key, 'cleared');
        }
    }
}
