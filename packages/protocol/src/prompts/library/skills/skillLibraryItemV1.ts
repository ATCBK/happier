export type SkillLibraryItemV1 = Readonly<{
  skillId: string; name: string; digest: string; description: string;
  disableModelInvocation: boolean; userInvocable: boolean; updatedAt?: number;
}>;

export function readSkillFrontmatterV1(_markdown: string): Readonly<{
  name?: string; description?: string; disableModelInvocation: boolean; userInvocable: boolean;
}> {
  return { disableModelInvocation: false, userInvocable: true };
}
