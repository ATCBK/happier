import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';

import { t } from '@/text';

export type SessionFollowLevelPreset = 'everything' | 'important' | 'quiet' | 'custom';

/** A following Session's level in one line: the level, then when it wakes the receiving Session. */
export function describeSessionFollowLevel(preset: SessionFollowLevelPreset): string {
    const meaning = preset === 'custom' ? null : t(`session.collaboration.pane.followersSessionMeaning.${preset}`);
    return joinHappierFacts(t(`session.follow.policy.${preset}`), meaning);
}
