import { isReadOnlySkillProvenanceV1, type SkillListItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import type { mutateSkillRulesV1 } from '@happier-dev/protocol/prompts/library/skillRulesActionsV1';
import { isSkillOff } from '../status/skillStatus';

export function buildSkillsFirstRunSelection(items: readonly SkillListItemV1[]) {
  const off = items.filter(item => !isReadOnlySkillProvenanceV1(item.provenance) && isSkillOff(item));
  const used = off.filter(item => item.lastUsedAt !== undefined).sort((left, right) => right.lastUsedAt! - left.lastUsedAt!);
  return { items: [...used, ...off.filter(item => item.lastUsedAt === undefined)], preselectedIds: used.map(item => item.skillId) };
}

/** The one bulk write preserves any narrower rule while enabling Everywhere. */
export function skillsFirstRunTurnOnInput(skillIds: readonly string[]): Parameters<typeof mutateSkillRulesV1>[1] {
  return { items: skillIds.map(skillId => ({ skillId })), change: { kind: 'write', write: { place: { t: 'allMachines' }, state: 'on' } } };
}
