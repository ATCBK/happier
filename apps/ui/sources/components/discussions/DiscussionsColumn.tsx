import * as React from 'react';

import { useGlobalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { readSessionRouteServerId } from '@/hooks/session/sessionRouteServerScope';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';

import { DiscussionsList } from './DiscussionsList';

const NO_SERVER_IDS: readonly string[] = Object.freeze([]);

/**
 * The Discussions destination's column (lab T2-A): the Discussions you can read on the open Home, the
 * open one selected, beside its page. The Home is the route's (a link into another Home's Discussion
 * lists that Home), otherwise the active one. Without the column — a phone, or a collapsed column —
 * the index route stands this list as its first screen (`surface="page"`).
 */
export const DiscussionsColumn = React.memo(function DiscussionsColumn(
  props: Readonly<{
    surface?: 'plane' | 'page';
  }>,
) {
  const params = useGlobalSearchParams<{ serverId?: string | string[] }>();
  const routeServerId = readSessionRouteServerId(params);
  const activeScope = useActiveServerAccountScope();
  const serverId = routeServerId ?? activeScope?.serverId ?? null;
  const requestedServerIds = React.useMemo(
    () => (serverId ? [serverId] : NO_SERVER_IDS),
    [serverId],
  );
  const bindings = useServerCredentialAccountScopeBindings(requestedServerIds);
  const binding = React.useMemo(
    () => [...bindings.values()][0] ?? null,
    [bindings],
  );
  const address = React.useMemo(
    () => (binding ? { serverId: binding.scope.serverId } : null),
    [binding],
  );
  if (!binding || !address) {
    return (
      <SurfaceStateCard
        testID="discussions-column-unavailable"
        size="line"
        kind="unavailable"
        title={t('session.collaboration.discussion.bindingUnavailable')}
      />
    );
  }
  return (
    <DiscussionsList
      address={address}
      scope={binding.scope}
      presentation="column"
      surface={props.surface ?? 'plane'}
    />
  );
});
