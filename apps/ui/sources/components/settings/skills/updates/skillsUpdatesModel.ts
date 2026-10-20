import type { SkillListItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import type { SkillUpdateFileV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';

import { skillNeedsALook } from '../status/skillStatus';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';

export const SKILLS_UPDATES_ROUTE = SETTINGS_ROUTES.skillsUpdates;

export type SkillFileChoice = 'mine' | 'theirs';

/**
 * The Updates page's two groups (P6 §4.6): a skill the person never changed is safe to take ("Ready to
 * update"); one they changed whose source changed too asks per file ("Needs your choice").
 */
export function groupSkillUpdates(items: readonly SkillListItemV1[]): Readonly<{
  ready: readonly SkillListItemV1[];
  needsChoice: readonly SkillListItemV1[];
}> {
  const waiting = items.filter(
    (item) => item.upstream?.state === 'update_available',
  );
  return {
    ready: waiting.filter((item) => !item.modified),
    needsChoice: waiting.filter((item) => item.modified),
  };
}

/**
 * Whether any skill came from somewhere that can publish a newer version (the same
 * sources "Modified" is measured against). Without one, "up to date" would claim a check that means nothing.
 */
export function hasUpdatingSource(items: readonly SkillListItemV1[]): boolean {
  return items.some((item) => item.provenance.kind === 'registry' || item.provenance.kind === 'link' || item.provenance.kind === 'wellKnown');
}

/** The rail's Updates count: only skills with a newer version waiting (never a removed source). */
export function countSkillUpdates(items: readonly SkillListItemV1[]): number {
  return items.filter((item) => item.upstream?.state === 'update_available')
    .length;
}

/**
 * Where "Review" on a Needs-a-look row leads: a waiting update opens Updates (where it can be taken);
 * a skill its source removed opens its own page (keep the copy or remove it).
 */
export function needsALookDestination(
  item: SkillListItemV1,
): 'updates' | 'detail' {
  return skillNeedsALook(item) && item.upstream?.state === 'update_available'
    ? 'updates'
    : 'detail';
}

/**
 * Each changed file's first choice. The diff carries both sides but no common base, so it cannot tell
 * "both changed" from "only theirs changed": a file only the source has (or a file the source edited
 * that the person never had) takes theirs; anywhere both sides hold text, the person's copy is kept
 * until they choose otherwise ("Nothing changes until you choose").
 */
export function defaultSkillFileChoices(
  files: readonly SkillUpdateFileV1[],
): Readonly<Record<string, SkillFileChoice>> {
  const choices: Record<string, SkillFileChoice> = {};
  for (const file of files) {
    if (!file.changed) continue;
    choices[file.path] = file.mine === null ? 'theirs' : 'mine';
  }
  return choices;
}

/**
 * `skills.updates.apply`'s choices: exactly one per changed file, from the person's picks over the
 * defaults; unchanged files carry none (there is nothing to choose).
 */
export function skillUpdateApplyChoices(
  files: readonly SkillUpdateFileV1[],
  picked: Readonly<Record<string, SkillFileChoice>>,
): Readonly<Record<string, SkillFileChoice>> {
  const defaults = defaultSkillFileChoices(files);
  const choices: Record<string, SkillFileChoice> = {};
  for (const file of files) {
    if (!file.changed) continue;
    choices[file.path] = picked[file.path] ?? defaults[file.path] ?? 'mine';
  }
  return choices;
}
