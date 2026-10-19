import * as React from 'react';

import { Modal } from '@/modal';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { isScmActionNotRun } from '@/sync/ops/scm/scmActionInvocation';

type RepositoryInitResponse = Readonly<{
    success: boolean;
    error?: string;
}>;

/**
 * The folder is not a repository yet (session-tabs lab ST "Git · not a repository"): an empty state that
 * invites — what the pane would do here, and the one next step (Initialize repository) when the
 * backend can create one. Built on the shared pane-states composition, so it takes its container's size.
 */
export function NotSourceControlRepositoryState(props: Readonly<{
    canInitializeRepository?: boolean;
    initializeRepositoryBusy?: boolean;
    onInitializeRepository?: () => Promise<RepositoryInitResponse>;
    onRefresh?: () => Promise<void>;
    /** The folder's name, so the promise says which folder ("happier isn’t a repository yet"). */
    folderName?: string | null;
}>): React.ReactElement {
    const [busy, setBusy] = React.useState(false);

    const initializeRepository = React.useCallback(() => {
        const onInitializeRepository = props.onInitializeRepository;
        if (!onInitializeRepository || busy || props.initializeRepositoryBusy) return;
        void (async () => {
            setBusy(true);
            try {
                const response = await onInitializeRepository();
                if (isScmActionNotRun(response)) return;
                if (!response.success) {
                    Modal.alert(t('common.error'), response.error || t('files.sourceControlOperations.repositoryInit.failed'));
                    return;
                }
                await props.onRefresh?.();
            } finally {
                setBusy(false);
            }
        })();
    }, [busy, props]);

    const folderName = props.folderName?.trim();
    return (
        <SurfaceStateCard
            testID="scm-not-repository"
            kind="empty"
            iconName="git-branch"
            title={t('sessionGitPane.notRepository.title')}
            reason={folderName
                ? t('sessionGitPane.notRepository.body', { folder: folderName })
                : t('sessionGitPane.notRepository.bodyUnnamed')}
            {...(props.canInitializeRepository === true
                ? { action: { label: t('files.sourceControlOperations.repositoryInit.action'), onPress: initializeRepository } }
                : {})}
        />
    );
}
