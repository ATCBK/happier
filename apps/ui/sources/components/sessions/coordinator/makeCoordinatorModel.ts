import type { OpenedSessionFollowRuleV1 } from '@happier-dev/protocol/sessions/follow/actions';
import type { SessionCoordinatorEnableInputV1 } from '@happier-dev/protocol/sessions/follow/sessionCoordinatorActionsV1';
import {
    prepareSessionCoordinatorSetupV1,
    type SessionCoordinatorCreationDefaultsV1,
    type SessionCoordinatorRuleCensusV1,
} from '@happier-dev/protocol/sessions/follow/sessionCoordinatorSetupV1';
import type { FollowRulePreviewResultV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRulePreviewV1';
import type { QualifiedProjectKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { resolveCoordinatorKeepDefault } from '@happier-dev/protocol/account/settings/accountSettings';

type RuleSuggestion =
    SessionCoordinatorEnableInputV1['ruleSuggestions'][number];
export type MakeCoordinatorKeep = SessionCoordinatorEnableInputV1['keep'];

export type MakeCoordinatorRuleDraft = Readonly<{
    scope: 'project' | 'home';
    suggestion: RuleSuggestion;
    enabled: boolean;
}>;

export type MakeCoordinatorDraft = Readonly<{
    roleId: string;
    keep: MakeCoordinatorKeep;
    /** True while the place is still the one the Settings default resolved to (the dialog says "From your setting"). */
    keepFromSetting: boolean;
    keepPreference: SessionCoordinatorCreationDefaultsV1['coordinationCoordinatorKeep'];
    managedBySessionId: string | null;
    answersWorkerQuestions: boolean;
    rules: readonly MakeCoordinatorRuleDraft[];
}>;

/**
 * The dialog's starting choices (C1 §6, lab P3 M/M2/M1): the project rule first and on, the Home-wide rule
 * second and off (on when the session has no project); the place the Settings default resolves to for that
 * scope; Managed by only when exactly one other session follows Home-wide. Protocol owns every suggestion.
 */
export function buildMakeCoordinatorDraft(
    input: Readonly<{
        serverId: string;
        sessionId: string;
        project: QualifiedProjectKeyV1 | null;
        settings: SessionCoordinatorCreationDefaultsV1;
        ruleIds: Readonly<{ project: string; home: string }>;
        ruleCensus: SessionCoordinatorRuleCensusV1 | null;
    }>,
): MakeCoordinatorDraft {
    const scope = input.project ? 'project' : 'home';
    // Both suggestions are prepared so the person can turn either on; the Settings switches decide which appear.
    const setup = prepareSessionCoordinatorSetupV1({
        serverId: input.serverId,
        sessionId: input.sessionId,
        scope,
        project: input.project,
        settings: {
            ...input.settings,
            coordinationCoordinatorSuggestHomeRule: true,
            coordinationCoordinatorSuggestProjectRule: input.project !== null,
        },
        ruleIds: input.ruleIds,
        ruleCensus: input.ruleCensus,
    });
    const rules: MakeCoordinatorRuleDraft[] = setup.ruleSuggestions.flatMap(
        (suggestion): MakeCoordinatorRuleDraft[] => {
            const ruleScope =
                suggestion.source.ruleId === input.ruleIds.project ? 'project' : 'home';
            const offered =
                ruleScope === 'project'
                    ? input.settings.coordinationCoordinatorSuggestProjectRule
                    : input.settings.coordinationCoordinatorSuggestHomeRule ||
                        scope === 'home';
            return offered
                ? [{ scope: ruleScope, suggestion, enabled: ruleScope === scope }]
                : [];
        },
    );
    return {
        roleId: setup.roleId,
        keep: setup.keep,
        keepFromSetting: true,
        keepPreference: setup.keepPreference,
        managedBySessionId: setup.managedBySessionId,
        answersWorkerQuestions: setup.answersWorkerQuestions,
        rules,
    };
}

/** Turning a rule on or off re-resolves the place while it still follows the Settings default. */
export function toggleMakeCoordinatorRule(
    draft: MakeCoordinatorDraft,
    scope: 'project' | 'home',
    enabled: boolean,
): MakeCoordinatorDraft {
    const rules = draft.rules.map((rule) =>
        rule.scope === scope ? { ...rule, enabled } : rule,
    );
    if (!draft.keepFromSetting) return { ...draft, rules };
    const homeWide = rules.some((rule) => rule.scope === 'home' && rule.enabled);
    return {
        ...draft,
        rules,
        keep: resolveCoordinatorKeepDefault(
            draft.keepPreference,
            homeWide ? 'home' : 'project',
        ),
    };
}

export function buildMakeCoordinatorEnableInput(
    draft: MakeCoordinatorDraft,
    current: Readonly<{ currentManagerSessionId: string | null }>,
): Omit<SessionCoordinatorEnableInputV1, 'sessionId'> {
    return {
        roleId: draft.roleId,
        keep: draft.keep,
        answersWorkerQuestions: draft.answersWorkerQuestions,
        ruleSuggestions: draft.rules
            .filter((rule) => rule.enabled)
            .map((rule) => rule.suggestion),
        ...(draft.managedBySessionId !== current.currentManagerSessionId
            ? {
                    managedBy: {
                        managerSessionId: draft.managedBySessionId,
                        expectedManagerSessionId: current.currentManagerSessionId,
                    },
                }
            : {}),
    };
}

export type MakeCoordinatorOverlap = Readonly<{
    rule: OpenedSessionFollowRuleV1;
    receiverSessionId: string;
    count: number;
}>;

/** Which other sessions' rules already hear about the sessions this rule would match, and how many. */
export function describeMakeCoordinatorOverlap(
    input: Readonly<{
        sessionId: string;
        census: SessionCoordinatorRuleCensusV1 | null;
        overlaps: FollowRulePreviewResultV1['overlaps'];
    }>,
): readonly MakeCoordinatorOverlap[] {
    if (!input.census || input.census.coverage !== 'complete') return [];
    const byId = new Map(input.census.rules.map((rule) => [rule.ruleId, rule]));
    return input.overlaps.flatMap((overlap) => {
        const rule = byId.get(overlap.ruleId);
        if (
            !rule ||
            rule.receiver.kind !== 'session' ||
            rule.receiver.sessionId === input.sessionId ||
            overlap.matches.length === 0
        )
            return [];
        return [
            {
                rule,
                receiverSessionId: rule.receiver.sessionId,
                count: overlap.matches.length,
            },
        ];
    });
}
