import { OpenedSessionFollowRuleV1Schema, type OpenedSessionFollowRuleV1 } from '@happier-dev/protocol/sessions/follow/actions';
import { excludeProjectFromSessionFollowRuleV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRulePreviewV1';
import type { QualifiedProjectKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { executeSessionFollowAction } from './sessionFollowApi';

export type FollowRuleProjectExclusionUndo = Readonly<{
    serverId: string;
    previous: OpenedSessionFollowRuleV1;
    expectedVersion: number;
}>;

async function writeDefinition(
    serverId: string,
    rule: OpenedSessionFollowRuleV1,
    expectedVersion: number,
    signal?: AbortSignal,
) {
    const { policy, ...ruleDefinition } = rule.definition;
    const result = await executeSessionFollowAction('follow.set', {
        receiver: rule.receiver, source: { kind: 'rule', ruleId: rule.ruleId },
        ruleDefinition, policy, expectedVersion,
    }, serverId, signal);
    if (result.kind === 'failed') return result;
    return 'rule' in result.value
        ? { kind: 'ok' as const, value: result.value.rule }
        : { kind: 'failed' as const, error: 'unavailable' as const };
}

/** One visible edit to the other rule; the original draft is kept for a version-bound Undo. */
export async function leaveProjectToFollowRule(input: Readonly<{
    serverId: string;
    rule: OpenedSessionFollowRuleV1;
    project: QualifiedProjectKeyV1;
    signal?: AbortSignal;
}>) {
    const previous = OpenedSessionFollowRuleV1Schema.parse(input.rule);
    const edited = { ...previous, definition: excludeProjectFromSessionFollowRuleV1(previous.definition, input.project) };
    const result = await writeDefinition(input.serverId, edited, previous.version, input.signal);
    if (result.kind === 'failed') return result;
    return { kind: 'ok' as const, value: { rule: result.value, undo: {
        serverId: input.serverId, previous, expectedVersion: result.value.version,
    } satisfies FollowRuleProjectExclusionUndo } };
}

/** A later edit causes a conflict; Undo never overwrites it or re-resolves another rule. */
export function undoFollowRuleProjectExclusion(undo: FollowRuleProjectExclusionUndo, signal?: AbortSignal) {
    return writeDefinition(undo.serverId, undo.previous, undo.expectedVersion, signal);
}
