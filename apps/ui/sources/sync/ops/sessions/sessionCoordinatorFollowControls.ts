import { FollowListActionOutputV1Schema, type FollowRuleSetActionInputV1, type OpenedSessionFollowRuleV1 } from '@happier-dev/protocol/sessions/follow/actions';
import { deriveSessionCoordinatorV1 } from '@happier-dev/protocol/sessions/follow/sessionCoordinatorV1';
import { normalizeSessionListFilterV1, type SessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

export type SessionCoordinatorRuleRemovalPlan = Readonly<{
    status: 'ready'; coverage: 'complete'; rules: readonly OpenedSessionFollowRuleV1[];
}> | Readonly<{ status: 'unavailable'; coverage: 'partial' | 'unavailable' }>;

/** An incomplete census cannot authorize treating the missing rules as absent. */
export function planSessionCoordinatorRuleRemoval(address: SessionAddress, value: unknown): SessionCoordinatorRuleRemovalPlan {
    const snapshot = FollowListActionOutputV1Schema.parse(value);
    if (snapshot.coverage !== 'complete') return { status: 'unavailable', coverage: snapshot.coverage };
    return { status: 'ready', coverage: 'complete', rules: snapshot.rules.filter(rule =>
        rule.receiver.kind === 'session' && rule.receiver.sessionId === address.sessionId) };
}

export type SessionCoordinatorRemovedRule = Readonly<{ previous: OpenedSessionFollowRuleV1; expectedVersion: number }>;

/** Restore only the acknowledged deletion, preserving the original policy and definition. */
export function createSessionCoordinatorRestoreInput(removed: SessionCoordinatorRemovedRule): FollowRuleSetActionInputV1 {
    const { policy, ...ruleDefinition } = removed.previous.definition;
    return { receiver: removed.previous.receiver, source: { kind: 'rule', ruleId: removed.previous.ruleId },
        ruleDefinition, policy, expectedVersion: removed.expectedVersion };
}

type ControlAvailability = 'enabled' | 'disabled' | 'unavailable';
export type SessionCoordinatorControls = Readonly<{
    coordinator: boolean | undefined;
    make: ControlAvailability;
    stop: ControlAvailability;
    edit: Readonly<{ kind: 'session_following'; address: SessionAddress; tab: 'collaboration'; direction: 'following' }>;
    openAsBoard: Readonly<{ kind: 'session_board'; address: SessionAddress; filter: SessionListFilterV1 }>;
}>;

/** Nonvisual intents; People and Board retain ownership of navigation and presentation. */
export function deriveSessionCoordinatorControls(input: Readonly<{
    address: SessionAddress;
    managedSessions?: Readonly<{ total: number }> | null;
    receivedRuleCount?: number;
    receivedRuleCoverage: 'complete' | 'partial' | 'unavailable';
}>): SessionCoordinatorControls {
    const receivedRuleCount = input.receivedRuleCoverage === 'complete' || (input.receivedRuleCount ?? 0) > 0
        ? input.receivedRuleCount : undefined;
    const coordinator = deriveSessionCoordinatorV1({ managedSessions: input.managedSessions, receivedRuleCount });
    return {
        coordinator,
        make: coordinator === undefined ? 'unavailable' : coordinator ? 'disabled' : 'enabled',
        stop: input.receivedRuleCoverage !== 'complete' || receivedRuleCount === undefined
            ? 'unavailable' : receivedRuleCount > 0 ? 'enabled' : 'disabled',
        edit: { kind: 'session_following', address: input.address, tab: 'collaboration', direction: 'following' },
        openAsBoard: { kind: 'session_board', address: input.address, filter: normalizeSessionListFilterV1({
            scope: 'all_accessible', show: 'both', homeServerIds: [input.address.serverId], underSessionId: input.address.sessionId,
        }) },
    };
}
