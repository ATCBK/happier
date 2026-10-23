import * as React from 'react';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildSessionListFilterQueryHomes, resolveSessionListViewContextDefaults } from '@/components/sessions/shell/search/sessionListViewFilters';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useSessionListQuerySourceState } from '@/sync/domains/session/listing/useSessionListQuerySourceState';
import { buildSessionListReachabilityRenderableKey, useSessionListRowRenderablesForItems, useSetting } from '@/sync/domains/state/storage';
import { getSessionName, getSessionSubtitle } from '@/utils/sessions/sessionUtils';
import { t } from '@/text';

import type { TeamSectionContext } from './teamSectionContext';
import { teamSessionsPath } from './teamsRoutes';

/** The two rows in tsOverview-A are a viewport, never a competing pagination budget. */
const SESSION_PREVIEW_COUNT = 2;

export const TeamSharedSessionsSection = React.memo(function TeamSharedSessionsSection(props: Readonly<{ context: TeamSectionContext }>) {
    const { address } = props.context;
    const router = useRouter();
    const hideInactive = useSetting('hideInactiveSessions');
    const homes = React.useMemo(() => {
        const mountedHomeServerIds = [address.serverId];
        const { defaults } = resolveSessionListViewContextDefaults({ kind: 'team', team: address }, mountedHomeServerIds, 'all');
        return buildSessionListFilterQueryHomes(defaults, {
            storage: 'active',
            includeInactive: !hideInactive,
            mountedHomeServerIds,
        }).map((home) => ({ ...home, queryMembership: 'rowOnly' as const }));
    }, [address.serverId, address.teamId, hideInactive]);
    // Exactly the Team Sessions surface's query/filter/read owners. Secondary consumers hydrate
    // rows without replacing the mounted Sessions view's membership or filters.
    const source = useSessionListQuerySourceState({ enabled: true, homes });
    const state = source.statesByServerId[address.serverId];
    const denied = state?.failureReason === 'access_denied';
    const items = React.useMemo(() => denied ? [] : (source.source ?? [])
        .filter((item) => item.type === 'session')
        .slice(0, SESSION_PREVIEW_COUNT), [denied, source.source]);
    const renderables = useSessionListRowRenderablesForItems(items);
    const loading = !state || state.phase === 'idle' || state.phase === 'loading' || state.phase === 'not_selected';
    const failed = denied || state?.phase === 'error' || state?.phase === 'offline';
    const empty = !loading && !failed && source.coverageComplete && items.length === 0;

    return (
        <ItemGroup title={t('teams.overview.sharedSessions')}>
            {loading ? <ItemLoadStateRows testID="team-overview-sessions-state" state={{ kind: 'loading' }} rows={SESSION_PREVIEW_COUNT} /> : null}
            {failed ? <SurfaceStateCard
                testID="team-overview-sessions-state"
                kind={denied ? 'denied' : 'error'}
                size="line"
                title={denied ? t('teams.denied.title') : state?.failureReason === 'unsupported'
                    ? t('sessionsList.teamListingUnavailableTitle')
                    : t('sessionsList.queryRefreshFailedTitle')}
                reason={denied ? undefined : state?.failureReason === 'unsupported'
                    ? t('sessionsList.teamListingUnavailableDescription')
                    : items.length ? t('sessionsList.queryRefreshFailedRetainedDescription') : t('sessionsList.queryRefreshFailedEmptyDescription')}
                action={denied || state?.failureReason === 'unsupported' ? undefined : { label: t('common.retry'), onPress: source.retry }}
            /> : null}
            {empty ? <SurfaceStateCard testID="team-overview-sessions-empty" kind="empty" size="line" title={t('sessionsList.queryTeamEmptyDescription')} /> : null}
            {items.map((item) => {
                const key = buildSessionListReachabilityRenderableKey(address.serverId, item.sessionId);
                const session = key ? renderables.get(key) : undefined;
                return session ? <Item
                    key={key}
                    testID={`team-overview-session:${item.sessionId}`}
                    icon={<Icon name="chats-circle" />}
                    title={getSessionName(session, address.serverId)}
                    subtitle={getSessionSubtitle(session, address.serverId)}
                    onPress={() => router.push(buildScopedSessionRouteHref({ sessionId: item.sessionId, serverId: address.serverId }))}
                /> : null;
            })}
            {/* A control on a set known to be empty would lead nowhere; the quiet line above says so. */}
            {empty ? null : <Item
                testID="team-overview-sessions"
                title={t('teams.overview.allSharedSessions')}
                onPress={() => router.push(teamSessionsPath(address))}
            />}
        </ItemGroup>
    );
});
