export type SkillLibraryItemV1 = Readonly<{
  skillId: string; name: string; digest: string; description: string;
  disableModelInvocation: boolean; userInvocable: boolean; updatedAt?: number;
}>;

export const SKILL_NAME_PATTERN_V1 = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** One frontmatter projection for registry discovery, delivery and the picker. */
export function readSkillFrontmatterV1(markdown: string): Readonly<{
  name?: string; description?: string; disableModelInvocation: boolean; userInvocable: boolean;
}> {
  const match = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
  const out: { name?: string; description?: string; disableModelInvocation: boolean; userInvocable: boolean } = {
    disableModelInvocation: false, userInvocable: true,
  };
  if (!match) return out;
  for (const line of match[1]!.split(/\r?\n/)) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    if (!value) continue;
    if (key === 'name' && SKILL_NAME_PATTERN_V1.test(value)) out.name = value;
    if (key === 'description') out.description = value;
    if (key === 'disable-model-invocation') out.disableModelInvocation = value === 'true';
    if (key === 'user-invocable') out.userInvocable = value !== 'false';
  }
  return out;
}
