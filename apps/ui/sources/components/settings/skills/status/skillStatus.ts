import { deriveSkillAccountStatusesV1 } from '@happier-dev/protocol/prompts/library/skills/skillStatusV1';
import type { SkillListItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';

import type { CapabilityStatus } from '@/components/capabilities/status/capabilityStatusPresentation';

/**
 * A skill's statuses in P5's vocabulary, for the page, the homepage and the P8 popover. The
 * account-derivable facts come from the protocol owner (`deriveSkillAccountStatusesV1`, which the
 * `skills.list` filter uses too); device and machine facts (masked from the Found cache, offline,
 * join here as their producers land (U6.5). Usage is an Account fact owned by the protocol.
 */
export function skillStatus(
  item: SkillListItemV1,
  usage?: Readonly<{ nowMs: number; usageObservedSince: number | null }>,
): readonly CapabilityStatus[] {
  return deriveSkillAccountStatusesV1(item, usage).map((kind): CapabilityStatus => ({
    kind,
  }));
}

/**
 * "Needs a look" (IR-80): an update is waiting, or the person changed a skill whose source changed
 * too, or its source removed it and the person must choose what to keep. Never a readiness guess,
 * an ordinary local modification, or Off alone.
 */
export function skillNeedsALook(item: SkillListItemV1): boolean {
  return deriveSkillAccountStatusesV1(item).includes('update')
    || item.upstream?.state === 'removed_from_source';
}

/** On nowhere (no rule turns it on): its row lives in the Off group (D4). */
export function isSkillOff(item: SkillListItemV1): boolean {
  return deriveSkillAccountStatusesV1(item).includes('off');
}
