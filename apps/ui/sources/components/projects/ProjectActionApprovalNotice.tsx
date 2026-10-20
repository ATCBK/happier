import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import * as React from 'react';

import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { t } from '@/text';

import type { ProjectsListModel } from './useProjectsListModel';

/**
 * A Project change (rename, reset, Forget) that the person's Action policy sent for approval: the shared
 * pending notice, whose Review opens that exact approval on the Home it was created on. Nothing here
 * assumes it ran; the row changes only when the approved Action executes.
 */
export const ProjectActionApprovalNotice = React.memo(
  function ProjectActionApprovalNotice(
    props: Readonly<{
      testID?: string;
      request: ProjectsListModel['projectActionApproval'];
      onDismiss: () => void;
    }>,
  ) {
    const router = useRouter();
    // The model only keeps a request while its Account scope is current, so this is the Home it was made on.
    const scope = useActiveServerAccountScope();
    if (!props.request || !scope) return null;
    const artifactId = props.request.artifactId;
    const serverId = scope.serverId;
    return (
      <ActionApprovalPendingNotice
        testID={props.testID ?? 'projects-action-approval'}
        message={t('projects.identity.waitingForApproval')}
        onOpenApproval={() => {
          props.onDismiss();
          router.push(
            buildApprovalHref(artifactId, serverId),
          );
        }}
      />
    );
  },
);
