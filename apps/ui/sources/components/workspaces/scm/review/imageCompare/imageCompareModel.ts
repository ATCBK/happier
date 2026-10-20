export type ImageComparePreview =
    | Readonly<{ status: 'loaded'; uri: string; sizeBytes?: number | null }>
    | Readonly<{ status: 'empty' }>
    | Readonly<{ status: 'disabled' | 'loading' }>
    | Readonly<{ status: 'error'; error: string; errorCode?: string }>;

export type ImageCompareSide =
    | Readonly<{ kind: 'present'; uri: string; sizeBytes: number | null }>
    | Readonly<{ kind: 'added' | 'deleted' }>
    | Readonly<{ kind: 'unreadable'; reason: string }>
    | Readonly<{ kind: 'noPreview'; reason: 'disabled' | 'loading' | 'empty' | 'too_large' | 'unsupported' }>;

export type ImageCompareModel<StageItem> = Readonly<{
    before: ImageCompareSide;
    after: ImageCompareSide;
    gallery: readonly StageItem[];
}>;

function previewSide(preview: ImageComparePreview): ImageCompareSide {
    if (preview.status === 'empty') return { kind: 'noPreview', reason: 'empty' };
    if (preview.status === 'error') {
        return preview.errorCode === 'too_large' || preview.errorCode === 'unsupported'
            ? { kind: 'noPreview', reason: preview.errorCode }
            : { kind: 'unreadable', reason: preview.error };
    }
    if (preview.status !== 'loaded') return { kind: 'noPreview', reason: preview.status };
    if (preview.sizeBytes === 0 || !preview.uri) return { kind: 'noPreview', reason: 'empty' };
    return { kind: 'present', uri: preview.uri, sizeBytes: preview.sizeBytes ?? null };
}

/** Projects preview results only; comparison evidence is the sole absence authority. */
export function buildImageCompareModel<StageItem = never>(input: Readonly<{
    changeKind: string;
    before: ImageComparePreview;
    after: ImageComparePreview;
    /** Canonical Media stage items, retaining their preview source/cache lifetime. */
    beforeItem?: StageItem;
    afterItem?: StageItem;
}>): ImageCompareModel<StageItem> {
    const before = input.changeKind === 'added' || input.changeKind === 'untracked' ? { kind: 'added' as const } : previewSide(input.before);
    const after = input.changeKind === 'deleted' ? { kind: 'deleted' as const } : previewSide(input.after);
    const gallery: StageItem[] = [];
    if (before.kind === 'present' && input.beforeItem !== undefined) gallery.push(input.beforeItem);
    if (after.kind === 'present' && input.afterItem !== undefined) gallery.push(input.afterItem);
    return { before, after, gallery };
}
