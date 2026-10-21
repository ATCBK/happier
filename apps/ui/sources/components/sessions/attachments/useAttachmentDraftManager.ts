import * as React from 'react';

import type { AttachmentUploadSource, AddWebAttachmentsOptions } from '@/sync/domains/attachments/attachmentsUploadFileSource';
import type { PickedAttachment, AttachmentFilePickerHandle } from '@/components/sessions/attachments/AttachmentFilePicker.types';
import type { AgentInputAttachment } from '@/components/sessions/agentInput/agentInputContracts';
import { Modal } from '@/modal';
import { t } from '@/text';
import { randomUUID } from '@/platform/randomUUID';
import { resolveFileViewerKind } from '@/scm/utils/filePresentation';
import { sendableAttachmentDrafts, type AttachmentDraft } from './attachmentDraftModel';
import type { AttachmentsUploadConfig } from '@/sync/domains/transfers/ops/uploadSessionAttachment';
import type { SessionAttachmentTransferContext } from '@/sync/domains/transfers/runtime/transferRuntime/families/sessionAttachmentTransfers';
import type { ExactSessionMachineTargetIdentity } from '@/sync/ops/sessionMachineTarget';

function resolveSourceSizeBytes(source: AttachmentUploadSource): number | null {
    if (source.kind === 'folder') return source.entries.reduce((total, entry) => total + (resolveSourceSizeBytes(entry.source) ?? 0), 0);
    if (source.kind === 'web') return source.file.size;
    if (source.kind === 'memory') return source.bytes.byteLength;
    return typeof source.sizeBytes === 'number' && Number.isFinite(source.sizeBytes) ? source.sizeBytes : null;
}

function resolveSourceName(source: AttachmentUploadSource): string {
    if (source.kind === 'web') return source.file.name;
    return source.name;
}

function isImageSource(source: AttachmentUploadSource): boolean {
    if (source.kind === 'folder') return false;
    const viewer = resolveFileViewerKind(source.kind === 'web'
        ? { path: source.file.name, mimeType: source.file.type }
        : { path: source.name, mimeType: source.mimeType, ...(source.kind === 'memory' ? { head: source.bytes } : {}) });
    return viewer.kind === 'image' || viewer.kind === 'svg';
}

export function useAttachmentDraftManager(params: Readonly<{
    enabled: boolean;
    maxFileBytes: number;
    initialDrafts?: readonly AttachmentDraft[];
    eagerUpload?: Readonly<{ sessionId: string; sessionTarget?: ExactSessionMachineTargetIdentity;
        config: AttachmentsUploadConfig; transferContext?: SessionAttachmentTransferContext }>;
    /** Picked uploads mention the exact drafts admitted by this intake owner. */
    onPickedDrafts?: (drafts: readonly AttachmentDraft[]) => void;
    /** The mounted document owner removes exact chip occurrences in the same user action. */
    onRemoveDraft?: (id: string) => void;
}>): Readonly<{
    filePickerRef: React.RefObject<AttachmentFilePickerHandle | null>;
    drafts: readonly AttachmentDraft[];
    getDraftsSnapshot: () => readonly AttachmentDraft[];
    getSendableDraftsSnapshot: () => readonly AttachmentDraft[];
    /** Process-local mutation revision for compare-and-restore consumers. */
    getDraftRevisionSnapshot: () => number;
    hasSendableAttachments: boolean;
    agentInputAttachments: readonly AgentInputAttachment[];
    addWebFiles: (files: readonly File[], options?: AddWebAttachmentsOptions) => readonly AttachmentDraft[];
    addPickedAttachments: (picked: readonly PickedAttachment[]) => void;
    removeDraft: (id: string) => void;
    removeSubmittedDrafts: (submitted: readonly AttachmentDraft[]) => readonly AttachmentDraft[];
    clearDrafts: () => void;
    replaceDrafts: (drafts: readonly AttachmentDraft[]) => void;
    applyDraftPatch: (id: string, patch: Partial<Omit<AttachmentDraft, 'id' | 'source'>>, expectedSource?: AttachmentUploadSource) => void;
}> {
    const filePickerRef = React.useRef<AttachmentFilePickerHandle | null>(null);
    const [drafts, setDrafts] = React.useState<AttachmentDraft[]>(() => [...(params.initialDrafts ?? [])]);
    const draftsRef = React.useRef<AttachmentDraft[]>(params.initialDrafts ? [...params.initialDrafts] : []);
    const draftRevisionRef = React.useRef(0);
    const onRemoveDraftRef = React.useRef(params.onRemoveDraft);
    onRemoveDraftRef.current = params.onRemoveDraft;
    const onPickedDraftsRef = React.useRef(params.onPickedDrafts);
    onPickedDraftsRef.current = params.onPickedDrafts;
    const eagerUploadRef = React.useRef(params.eagerUpload);
    eagerUploadRef.current = params.eagerUpload;
    const eagerUploadsRef = React.useRef(new Map<string, AbortController>());

    const webPreviewUrlsRef = React.useRef<Map<string, string>>(new Map());
    const [webPreviewUrlsVersion, setWebPreviewUrlsVersion] = React.useState(0);

    const getDraftsSnapshot = React.useCallback(() => draftsRef.current, []);
    const getSendableDraftsSnapshot = React.useCallback(() => sendableAttachmentDrafts(draftsRef.current), []);
    const getDraftRevisionSnapshot = React.useCallback(() => draftRevisionRef.current, []);

    const commitDrafts = React.useCallback((updater: (previous: AttachmentDraft[]) => AttachmentDraft[]) => {
        // Keep this side effect outside React's updater: Strict Mode may replay
        // updater functions, but one public mutation call gets exactly one
        // currentness revision.
        draftRevisionRef.current += 1;
        // This manager is the process-local draft owner. Advance its snapshot
        // synchronously so an immediate Send observes the attachment even
        // before React commits the visual row. Using the ref as the input also
        // preserves multiple same-turn mutations without updater replay side
        // effects in Strict Mode.
        const next = updater(draftsRef.current);
        draftsRef.current = next;
        setDrafts(next);
    }, []);

    React.useEffect(() => {
        return () => {
            const map = webPreviewUrlsRef.current;
            const urlApi = globalThis.URL;
            for (const url of map.values()) {
                try { urlApi?.revokeObjectURL?.(url); } catch { }
            }
            map.clear();
        };
    }, []);

    const applyDraftPatch = React.useCallback((id: string, patch: Partial<Omit<AttachmentDraft, 'id' | 'source'>>, expectedSource?: AttachmentUploadSource) => {
        if (expectedSource && !draftsRef.current.some((draft) => draft.id === id && draft.source === expectedSource)) return;
        commitDrafts((prev) => prev.map((d) => d.id === id ? ({ ...d, ...patch } as AttachmentDraft) : d));
    }, [commitDrafts]);

    const startEagerUploads = React.useCallback((added: readonly AttachmentDraft[]) => {
        const target = eagerUploadRef.current;
        if (!target) return;
        for (const draft of added) {
            if (draft.source.kind !== 'folder' || draft.status !== 'pending' || draft.uploadedPath || eagerUploadsRef.current.has(draft.id)) continue;
            const controller = new AbortController();
            eagerUploadsRef.current.set(draft.id, controller);
            void import('./uploadAttachmentDraftsToSession').then(({ uploadAttachmentDraftsToSession }) => uploadAttachmentDraftsToSession({
                ...target, drafts: [draft], signal: controller.signal,
                applyDraftPatch: (id, patch) => applyDraftPatch(id, patch, draft.source),
            })).catch(() => {
                // The upload owner has already projected the failure onto this draft.
            }).finally(() => {
                if (eagerUploadsRef.current.get(draft.id) === controller) eagerUploadsRef.current.delete(draft.id);
            });
        }
    }, [applyDraftPatch]);

    React.useEffect(() => () => {
        for (const controller of eagerUploadsRef.current.values()) controller.abort();
        eagerUploadsRef.current.clear();
    }, [params.eagerUpload?.sessionId, params.eagerUpload?.sessionTarget?.serverId, params.eagerUpload?.sessionTarget?.accountId]);

    const addSources = React.useCallback((sources: readonly AttachmentUploadSource[]): readonly AttachmentDraft[] => {
        if (!params.enabled) return [];

        const next: AttachmentDraft[] = [];
        let skippedOversizeCount = 0;
        for (const source of sources) {
            const files = source.kind === 'folder' ? source.entries.map(entry => entry.source) : [source];
            if (files.some(file => (resolveSourceSizeBytes(file) ?? 0) > params.maxFileBytes)) {
                skippedOversizeCount += 1;
                continue;
            }
            next.push({
                id: randomUUID(),
                source,
                status: 'pending',
            });
        }

        if (skippedOversizeCount > 0) {
            Modal.alert(
                t('attachments.alerts.fileTooLargeTitle'),
                t('attachments.alerts.fileTooLargeBody', { count: skippedOversizeCount }),
            );
        }
        if (next.length === 0) return [];
        commitDrafts((prev) => [...prev, ...next]);
        startEagerUploads(next);
        return next;
    }, [commitDrafts, params.enabled, params.maxFileBytes, startEagerUploads]);

    const addWebFiles = React.useCallback((files: readonly File[], options?: AddWebAttachmentsOptions) => {
        return addSources(options?.sources ?? files.map((file) => ({ kind: 'web' as const, file })));
    }, [addSources]);

    const addPickedAttachments = React.useCallback((picked: readonly PickedAttachment[]) => {
        const added = addSources(picked);
        if (added.length > 0) onPickedDraftsRef.current?.(added);
    }, [addSources]);

    const removeDraft = React.useCallback((id: string) => {
        eagerUploadsRef.current.get(id)?.abort();
        onRemoveDraftRef.current?.(id);
        commitDrafts((prev) => prev.filter((d) => d.id !== id));
    }, [commitDrafts]);

    const removeSubmittedDrafts = React.useCallback((submitted: readonly AttachmentDraft[]) => {
        // Source objects are immutable through manager patches; upload checkpoints
        // retain their identity, while a replacement source must survive acceptance.
        const sourcesById = new Map(submitted.map((draft) => [draft.id, draft.source]));
        const current = draftsRef.current;
        const remaining = current.filter((draft) => sourcesById.get(draft.id) !== draft.source);
        if (remaining.length !== current.length) commitDrafts(() => remaining);
        return draftsRef.current;
    }, [commitDrafts]);

    const clearDrafts = React.useCallback(() => {
        commitDrafts(() => []);
    }, [commitDrafts]);

    const replaceDrafts = React.useCallback((nextDrafts: readonly AttachmentDraft[]) => {
        commitDrafts(() => [...nextDrafts]);
    }, [commitDrafts]);

    React.useEffect(() => {
        const map = webPreviewUrlsRef.current;
        const urlApi = globalThis.URL;
        let changed = false;

        const activeIds = new Set(drafts.map((d) => d.id));
        for (const [id, url] of map) {
            if (activeIds.has(id)) continue;
            try { urlApi?.revokeObjectURL?.(url); } catch { }
            map.delete(id);
            changed = true;
        }

        for (const draft of drafts) {
            if (draft.source.kind !== 'web') continue;
            if (!isImageSource(draft.source)) continue;
            if (map.has(draft.id)) continue;
            if (typeof urlApi?.createObjectURL !== 'function') continue;
            try {
                const url = urlApi.createObjectURL(draft.source.file);
                map.set(draft.id, url);
                changed = true;
            } catch {
                // ignore
            }
        }

        if (changed) {
            setWebPreviewUrlsVersion((v) => v + 1);
        }
    }, [drafts]);

    const agentInputAttachments = React.useMemo<readonly AgentInputAttachment[]>(() => {
        void webPreviewUrlsVersion;
        const webUrls = webPreviewUrlsRef.current;

        return drafts.map((d) => {
            const name = resolveSourceName(d.source);
            const imagePreviewUri = isImageSource(d.source)
                ? (
                    d.source.kind === 'native'
                        ? d.source.uri
                        : d.source.kind === 'memory'
                            ? d.source.previewUri ?? null
                            : (webUrls.get(d.id) ?? null)
                )
                : null;

            return {
                key: d.id,
                label: name,
                attachmentType: d.source.kind === 'folder' ? 'folder' as const : 'file' as const,
                status: d.status,
                preview: imagePreviewUri ? { kind: 'image', uri: imagePreviewUri } : undefined,
                uploadProgress: d.uploadProgress,
                error: d.error,
                onRemove: () => removeDraft(d.id),
            };
        });
    }, [drafts, removeDraft, webPreviewUrlsVersion]);

    // Referential stability contract: memoized consumers (composer, transcript rows) receive
    // this manager or its callbacks as props; a fresh object per render would re-render them
    // on every parent commit.
    return React.useMemo(() => ({
        filePickerRef,
        drafts,
        getDraftsSnapshot,
        getSendableDraftsSnapshot,
        getDraftRevisionSnapshot,
        hasSendableAttachments: sendableAttachmentDrafts(drafts).length > 0,
        agentInputAttachments,
        addWebFiles,
        addPickedAttachments,
        removeDraft,
        removeSubmittedDrafts,
        clearDrafts,
        replaceDrafts,
        applyDraftPatch,
    }), [
        addPickedAttachments,
        addWebFiles,
        agentInputAttachments,
        applyDraftPatch,
        clearDrafts,
        drafts,
        getDraftRevisionSnapshot,
        getDraftsSnapshot,
        getSendableDraftsSnapshot,
        removeDraft,
        removeSubmittedDrafts,
        replaceDrafts,
    ]);
}
