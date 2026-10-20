import * as React from 'react';
import type { ScmComparisonFile, ScmDiffArea } from '@happier-dev/protocol/scm';

import { useFileAtRevisionPreview } from '@/components/ui/media/useFileAtRevisionPreview';
import { useFilePreviewSource, type UseFilePreviewSourceInput } from '@/components/ui/media/useFilePreviewSource';
import { buildWorkspacePreviewIdentity } from '@/components/ui/media/buildWorkspacePreviewIdentity';
import type { MediaStageItem } from '@/components/ui/media/stage/mediaStageItems';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { resolveFileViewerKind } from '@/scm/utils/filePresentation';
import { buildImageCompareModel, projectImageComparePreview } from './imageCompareModel';

export type ImageCompareSource =
    | Readonly<{ kind: 'captured'; file: ScmComparisonFile; comparisonId: string }>
    | Readonly<{ kind: 'workingTree'; changeKind: string; area: ScmDiffArea; signature?: string | null; sizeBytes?: number | null }>;

/** Review and File Changes share pinned revision bytes and the normal live-after preview owner. */
export function useImageCompare(input: Readonly<{
    enabled: boolean;
    scope: WorkspaceScopeBase;
    filePath: string;
    source: ImageCompareSource;
    beforeTitle?: string;
    afterTitle?: string;
    openFile?: () => void;
}>) {
    const captured = input.source.kind === 'captured' ? input.source : null;
    const live = input.source.kind === 'workingTree' ? input.source : null;
    const changeKind = captured?.file.changeKind ?? live!.changeKind;
    const beforeAbsent = changeKind === 'added' || changeKind === 'untracked';
    const afterAbsent = changeKind === 'deleted';
    const viewer = resolveFileViewerKind({ path: input.filePath });
    const beforeViewer = resolveFileViewerKind({ path: captured?.file.previousPath ?? input.filePath });
    const beforeBlobId = captured?.file.beforeBlobId;
    const afterBlobId = captured?.file.afterBlobId;
    const before = useFileAtRevisionPreview({
        enabled: input.enabled && !beforeAbsent && (!captured || Boolean(beforeBlobId)),
        scope: input.scope, path: captured?.file.previousPath ?? input.filePath,
        selector: beforeBlobId ? { blobId: beforeBlobId } : { side: 'before', area: live?.area ?? 'both' },
        mimeType: beforeViewer.mimeType, signature: captured?.comparisonId ?? live?.signature,
    });
    const capturedAfter = useFileAtRevisionPreview({
        enabled: input.enabled && !afterAbsent && Boolean(captured && afterBlobId),
        scope: input.scope, path: input.filePath,
        selector: afterBlobId ? { blobId: afterBlobId } : { side: 'before', area: 'both' },
        mimeType: viewer.mimeType, signature: captured?.comparisonId,
    });
    const { serverId, machineId, rootPath } = input.scope;
    const liveAfterInput = React.useMemo<UseFilePreviewSourceInput>(() => ({
        enabled: input.enabled && !afterAbsent && Boolean(live),
        source: { kind: 'workspace', scope: { serverId, machineId, rootPath }, filePath: input.filePath },
        mimeType: viewer.mimeType, sizeBytes: live?.sizeBytes,
        ...buildWorkspacePreviewIdentity(input.scope, input.filePath, live?.sizeBytes, live?.signature),
    }), [input.enabled, afterAbsent, Boolean(live), serverId, machineId, rootPath, input.filePath, viewer.mimeType,
        live?.sizeBytes, live?.signature]);
    const liveAfter = useFilePreviewSource(liveAfterInput);
    const beforePreview = captured && !beforeAbsent && !beforeBlobId
        ? { status: 'error' as const, error: 'blob_unavailable', errorCode: 'blob_unavailable' }
        : projectImageComparePreview(before);
    const afterPreview = captured && !afterAbsent && !afterBlobId
        ? { status: 'error' as const, error: 'blob_unavailable', errorCode: 'blob_unavailable' }
        : projectImageComparePreview(captured ? capturedAfter : liveAfter);
    const kind = viewer.kind === 'svg' ? 'svg' as const : 'image' as const;
    const beforeItem: MediaStageItem = { kind: beforeViewer.kind === 'svg' ? 'svg' : 'image', title: input.beforeTitle ?? input.filePath, source: before.previewInput,
        ...('sizeBytes' in before ? { sizeBytes: before.sizeBytes } : {}), ...(input.openFile ? { openFile: input.openFile } : {}) };
    const afterInput = captured ? capturedAfter.previewInput : liveAfterInput;
    const afterItem: MediaStageItem = { kind, title: input.afterTitle ?? input.filePath, source: afterInput,
        ...(afterPreview.status === 'loaded' ? { sizeBytes: afterPreview.sizeBytes } : {}), ...(input.openFile ? { openFile: input.openFile } : {}) };
    const model = buildImageCompareModel({ changeKind, before: beforePreview, after: afterPreview, beforeItem, afterItem });
    return { ...model, beforePreviewInput: before.previewInput, afterPreviewInput: afterInput,
        beforeGalleryIndex: model.before.kind === 'present' ? 0 : null,
        afterGalleryIndex: model.after.kind === 'present' ? model.before.kind === 'present' ? 1 : 0 : null };
}
