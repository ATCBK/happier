import { PromptBundleArtifactHeaderV1Schema, PromptBundleBodyV1Schema } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import type { AccountArtifactHeader } from '@/api/artifacts/accountArtifactStore';
import { readSkillBundleFrontmatter } from '@/prompts/registries/shared/readSkillBundleFrontmatter';

export type SkillLibraryNameItem = Readonly<{ id: string; name: string }>;

/** Artifact inventory owns paging and decryption; skill names come from their canonical frontmatter reader. */
export async function readSkillLibraryItems(store: Readonly<{
  list(options: Readonly<{ kind: string; includeBody: boolean }>): Promise<Readonly<{
    items: readonly AccountArtifactHeader[]; coverage: 'complete' | 'partial';
  }>>;
}>): Promise<readonly SkillLibraryNameItem[]> {
  const inventory = await store.list({ kind: 'prompt_bundle.v2', includeBody: true });
  if (inventory.coverage !== 'complete') throw Object.assign(new Error('Skill library unavailable'), { code: 'catalog_unavailable' });
  const items: SkillLibraryNameItem[] = [];
  for (const artifact of inventory.items) {
    const header = PromptBundleArtifactHeaderV1Schema.safeParse(artifact.header);
    if (artifact.header.bundleSchemaId !== 'skills.skill_md_v1') continue;
    if (!header.success) throw Object.assign(new Error('Skill header unavailable'), { code: 'catalog_unavailable' });
    let body: unknown;
    try { body = typeof artifact.body === 'string' ? JSON.parse(artifact.body) : null; }
    catch { body = null; }
    const parsed = PromptBundleBodyV1Schema.safeParse(body);
    const skillMd = parsed.success ? parsed.data.entries.find(entry => entry.path === 'SKILL.md' && entry.contentKind === 'utf8') : undefined;
    if (!skillMd) throw Object.assign(new Error('Skill content unavailable'), { code: 'catalog_unavailable' });
    const frontmatter = readSkillBundleFrontmatter(Buffer.from(skillMd.contentBase64, 'base64').toString('utf8'));
    const name = frontmatter.name?.trim();
    if (!name) throw Object.assign(new Error('Skill name unavailable'), { code: 'catalog_unavailable' });
    items.push({ id: artifact.artifactId, name });
  }
  return items;
}
