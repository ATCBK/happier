import { readSkillLibraryCatalog } from '@happier-dev/protocol/prompts/library/skills/readSkillLibraryCatalog';
import type { AccountArtifactHeader } from '@/api/artifacts/accountArtifactStore';
import type { SkillActionPortV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionOperations';

export type SkillLibraryNameItem = Readonly<{ id: string; name: string }>;

/** Artifact inventory owns paging and decryption; skill names come from their canonical frontmatter reader. */
export async function readSkillLibraryItems(store: Readonly<{
  readPluginSkills?: SkillActionPortV1['readPluginSkills'];
  list(options: Readonly<{ kind: string; includeBody: boolean; limit?: number; cursor?: string }>): Promise<Readonly<{
    items: readonly AccountArtifactHeader[]; coverage: 'complete' | 'partial'; nextCursor?: string;
  }>>;
}>): Promise<readonly SkillLibraryNameItem[]> {
  return readSkillLibraryCatalog({ readPluginSkills: store.readPluginSkills, list: options => store.list({ ...options, kind: 'prompt_bundle.v2' }) });
}
