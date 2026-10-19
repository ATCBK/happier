import type { SkillInstallPreviewV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';

type Previewed = Pick<SkillInstallPreviewV1, 'path' | 'siblingSkills'>;

/** Everything previewed starts ticked: the person unticks what they do not want. */
export function tickAllSkillPreviews(items: readonly Previewed[]): ReadonlySet<string> {
  return new Set(items.map((item) => item.path));
}

/**
 * Ticking a skill ticks the siblings it refers to, so the reference holds once it is added; unticking changes
 * only that skill, and a sibling can be unticked on its own.
 */
export function toggleSkillPreview(
  items: readonly Previewed[],
  ticked: ReadonlySet<string>,
  path: string,
): ReadonlySet<string> {
  const next = new Set(ticked);
  if (next.delete(path)) return next;
  next.add(path);
  const listed = new Set(items.map((item) => item.path));
  for (const sibling of items.find((item) => item.path === path)?.siblingSkills ?? [])
    if (listed.has(sibling.path)) next.add(sibling.path);
  return next;
}
