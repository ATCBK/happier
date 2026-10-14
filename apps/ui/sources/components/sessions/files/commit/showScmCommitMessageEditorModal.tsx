import { Modal } from '@/modal';
import { createDeferredOnce } from '@/modal/async/createDeferredOnce';

import { ScmCommitMessageEditorModal, type ScmCommitMessageGenerateResult } from './ScmCommitMessageEditorModal';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';

export async function showScmCommitMessageEditorModal(params: Readonly<{
    initialMessage?: string;
    canGenerate: boolean;
    onGenerate: () => Promise<ScmCommitMessageGenerateResult>;
}>): Promise<string | null> {
    const deferred = createDeferredOnce<string | null>();
    const onResolve = (value: { kind: 'cancel' } | { kind: 'commit'; message: string }) => {
        deferred.resolve(value.kind === 'commit' ? value.message : null);
    };

    Modal.show({
        component: ScmCommitMessageEditorModal,
        props: {
            initialMessage: params.initialMessage ?? '',
            canGenerate: params.canGenerate,
            onGenerate: params.onGenerate,
            onResolve,
        },
        onRequestClose: () => onResolve({ kind: 'cancel' }),
        chrome: {
            kind: 'card',
            testID: 'scm-commit-message-editor-modal',
            bodyScroll: 'auto',
            dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide, maxHeightRatio: 0.92, size: 'md' },
        },
        closeOnBackdrop: true,
    });
    return await deferred.promise;
}
