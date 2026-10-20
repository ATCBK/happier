import * as React from 'react';
import { projectProjectListV1 } from '@happier-dev/protocol/workspaces';

import { resolveWorkspaceRefDisplayNames } from '@/components/projects/resolveWorkspaceRefDisplayName';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import {
  useProjectOrganizations,
  useWorkspaceRefs,
} from '@/sync/domains/state/storage';

import type { SessionListFilterProjectOption } from './sessionListFilterEditorModel';

/**
 * The Project facet's choices: the projects the Projects list shows for this Home (same projection, same
 * names), qualified by the Home so a filter never matches another Home's project of the same key.
 */
export function useSessionListFilterProjectOptions(): readonly SessionListFilterProjectOption[] {
  const serverId = String(useActiveServerSnapshot().serverId ?? '').trim();
  const workspaceRefs = useWorkspaceRefs();
  const organizations = useProjectOrganizations();
  return React.useMemo(() => {
    if (!serverId) return [];
    const { projectGroups } = projectProjectListV1({
      serverId,
      workspaceRefs: Array.isArray(workspaceRefs) ? workspaceRefs : [],
      organizations,
      normalizeServerId: resolveServerProfileScopeIdForIdentifier,
    });
    const names = resolveWorkspaceRefDisplayNames(
      projectGroups.flatMap((group) => group.items.slice(0, 1)),
    );
    return projectGroups.flatMap((group, index) =>
      group.items.length > 0
        ? [
            {
              serverId,
              projectKey: group.projectKey.projectKey,
              label: names[index] ?? group.projectKey.projectKey,
            },
          ]
        : [],
    );
  }, [organizations, serverId, workspaceRefs]);
}
