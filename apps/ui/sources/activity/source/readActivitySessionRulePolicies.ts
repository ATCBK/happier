import { matchSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import type { FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { normalizeSessionFollowDefaultRulesV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { buildSessionListRowFilterFacts } from '@/sync/domains/session/listing/sessionListWorkFilter';
import { isSessionContentReadable, readSessionContentAvailability } from '@/sync/domains/session/encryptedContentAvailability';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { ActivityAttentionSource } from './activityAttentionSourceTypes';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization';

const NO_RULE_POLICIES: readonly FollowPolicyV1[] = Object.freeze([]);
export function readActivityPersonalRuleSnapshot(source: Pick<ActivityAttentionSource, 'personalFollowRulesByServerId'>, serverId: string) {
    return source.personalFollowRulesByServerId?.[serverId]
        ?? Object.entries(source.personalFollowRulesByServerId ?? {}).find(([candidate]) => areServerProfileIdentifiersEquivalent(candidate, serverId))?.[1];
}

/** Presentation only: no enrollment, viewer mutation, event dispatch or second filter semantics. */
export function readActivitySessionRulePolicies(source: ActivityAttentionSource, address: SessionAddress, session: Session, nowMs: number): readonly FollowPolicyV1[] {
    if (session.archivedAt != null || !isSessionContentReadable(readSessionContentAvailability(session))
        || session.metadataLayoutVersion === 1 && readSessionOwnerMetadataView(session) == null) return NO_RULE_POLICIES;
    const follow = session.viewer?.follow;
    // The existing Follow facts distinguish an absent row (null) from explicit Unfollow.
    if (follow?.follows === false && follow.notificationLevel === 'none') return NO_RULE_POLICIES;
    const snapshot = readActivityPersonalRuleSnapshot(source, address.serverId);
    if (snapshot?.status !== 'ready') return NO_RULE_POLICIES;
    const defaults = snapshot.defaultPreferences ? normalizeSessionFollowDefaultRulesV1({ serverId: address.serverId,
        preferences: snapshot.defaultPreferences, relationships: follow?.defaultRelationships ?? {},
        hasPersistentFollow: follow == null ? undefined : follow.notificationLevel !== null }).rules : [];
    const rules = [...snapshot.rules.filter(rule => rule.receiver.kind === 'account' && rule.definition.enabled), ...defaults];
    if (rules.length === 0) return NO_RULE_POLICIES;
    const facts = buildSessionListRowFilterFacts(session, address.serverId, {
        nowMs, viewerAccountId: snapshot.accountId, workspaceRefs: source.followRuleWorkspaceRefsV1,
        tagIds: source.followRuleTagAssignmentsBySessionKey?.[buildSessionOrganizationSessionKey(address.serverId, session.id)]?.tagIds,
        includeStatus: rules.some(rule => Boolean(rule.definition.filter.statuses?.length)),
        includeSource: rules.some(rule => rule.definition.filter.source !== 'all'),
    });
    return rules.filter(rule => matchSessionListFilterV1(rule.definition.filter, facts) === 'match').map(rule => rule.definition.policy);
}
