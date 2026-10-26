import type { SessionFollowInputV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { followDeliveryMuteScopeKeyV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';

import { followInputNeedsYou } from '@/sync/domains/session/input/hostAuthoredInput';

export type FollowNoticeRow = Readonly<{
    id: string;
    followInput: SessionFollowInputV1 | null;
    /** Only a plainly queued row folds; a blocked or failing one stays its own row. */
    foldable: boolean;
}>;

export type FollowNoticeGroupPresentation =
    | Readonly<{ kind: 'folded' }>
    | Readonly<{ kind: 'lead'; count: number; followInput: SessionFollowInputV1 }>;

export function followNoticeSourceKey(input: SessionFollowInputV1): string {
    const { original } = input;
    return followDeliveryMuteScopeKeyV1({ kind: 'source', source: 'sourceSessionId' in original
        ? { kind: 'session', sessionId: original.sourceSessionId } : original.source });
}

/**
 * Presentation only: several queued Follow updates from one source read as one notice. The group sits
 * where its first update arrived and shows the most urgent state (a needs-you wins, the latest among
 * equals) with the count; the other rows are folded away from view. The pending rows themselves, their
 * order and their delivery are never touched, and only rows that are listed here are affected.
 */
export function groupFollowNoticesBySource(
    rows: readonly FollowNoticeRow[],
): ReadonlyMap<string, FollowNoticeGroupPresentation> {
    const bySource = new Map<string, { id: string; input: SessionFollowInputV1 }[]>();
    for (const row of rows) {
        if (!row.followInput || !row.foldable) continue;
        const key = followNoticeSourceKey(row.followInput);
        const members = bySource.get(key);
        if (members) members.push({ id: row.id, input: row.followInput });
        else bySource.set(key, [{ id: row.id, input: row.followInput }]);
    }
    const presentation = new Map<string, FollowNoticeGroupPresentation>();
    for (const members of bySource.values()) {
        if (members.length < 2) continue;
        const shown = [...members].reverse().find((member) => followInputNeedsYou(member.input)) ?? members[members.length - 1]!;
        presentation.set(members[0]!.id, { kind: 'lead', count: members.length, followInput: shown.input });
        for (const member of members.slice(1)) presentation.set(member.id, { kind: 'folded' });
    }
    return presentation;
}
