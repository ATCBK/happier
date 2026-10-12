import * as React from 'react';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { projectWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { SessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { useProjectSessions } from '@/sync/domains/state/storage';
import type { ProjectSessionsState } from '@/sync/domains/session/listing/useProjectSessions';

export type ProjectSessionsWidgetBodyProps = Readonly<{ sessions: ProjectSessionsState; testID: string }>;

/** Call only beneath the built-in descriptor/binder's admitted checkout. */
export function useProjectSessionsWidgetBody(checkout: WorkspaceRefV1, filters?: SessionListFilterV1): ProjectSessionsState {
    const project = React.useMemo(() => projectWorkspaceRefV1(checkout), [checkout.serverId, checkout.projectKey, checkout.id]);
    return useProjectSessions(project, filters);
}
