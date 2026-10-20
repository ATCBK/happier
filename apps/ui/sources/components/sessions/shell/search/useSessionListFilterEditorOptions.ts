import * as React from 'react';

import {
    useSessionListFeatureHomeSupportByServerId,
    useSessionListQueryHomeSupportByServerId,
} from '@/sync/domains/session/listing/useSessionListQuerySourceState';
import { useSessionOrganizationProjections } from '@/sync/domains/state/storage';

import { buildSessionListFilterAudienceOptions } from './SessionListFilterControl';
import { buildSessionListFilterTagOptions } from './sessionListFilterTagOptions';
import type { SessionListViewContext } from './sessionListViewFilters';
import {
    buildSessionListFilterHomeOptions,
    resolveSelectedHomeFeatureAvailability,
} from './useSessionListViewFilterController';

const GLOBAL_CONTEXT: SessionListViewContext = { kind: 'global' };

/**
 * The editor's choices for a stored `SessionListFilterV1` outside the Sessions list (a Board's inline
 * filter, the composer's Matching sessions): the list's own Home, audience and tag owners, and which
 * facets the selected Homes can answer.
 */
export function useSessionListFilterEditorOptions(
    mountedServerIds: readonly string[],
    selectedServerIds: readonly string[],
) {
    const homes = React.useMemo(() => buildSessionListFilterHomeOptions(mountedServerIds), [mountedServerIds]);
    const audiences = React.useMemo(() => buildSessionListFilterAudienceOptions(homes, GLOBAL_CONTEXT), [homes]);
    const organizationProjections = useSessionOrganizationProjections(mountedServerIds);
    const tags = React.useMemo(() => buildSessionListFilterTagOptions({
        homeOptions: homes,
        organizationProjectionsByServerId: organizationProjections,
    }), [homes, organizationProjections]);
    const queryEnabled = resolveSelectedHomeFeatureAvailability(
        selectedServerIds,
        useSessionListQueryHomeSupportByServerId(selectedServerIds, true),
    );
    const followingAvailable = resolveSelectedHomeFeatureAvailability(
        selectedServerIds,
        useSessionListFeatureHomeSupportByServerId('sessions.following', selectedServerIds, true),
    );
    const sourceAvailable = resolveSelectedHomeFeatureAvailability(
        selectedServerIds,
        useSessionListFeatureHomeSupportByServerId('sessions.direct', selectedServerIds, true),
    );
    return {
        homes,
        audiences,
        tags,
        teamAudienceContext: GLOBAL_CONTEXT,
        queryEnabled,
        followingAvailable,
        sourceAvailable,
    };
}
