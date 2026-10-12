import { decodeBase64 } from '../../../crypto/base64.js';
import { PromptBundleArtifactHeaderV1Schema, PromptBundleBodyV1Schema } from '../promptBundleSchemas.js';
import { readSkillFrontmatterV1 } from './skillLibraryItemV1.js';

/** Artifact inventory owns paging and decryption; the bundle owner supplies skill names. */
export async function readSkillLibraryCatalog(store: Readonly<{
  list(options: Readonly<{ includeBody: boolean; signal?: AbortSignal }>): Promise<Readonly<{
    items: readonly Readonly<{ artifactId: string; header: Readonly<Record<string, unknown>>; body?: string | null }>[];
    coverage: 'complete' | 'partial';
  }>>;
}>, signal?: AbortSignal): Promise<readonly Readonly<{ id: string; name: string }>[]> {
  const inventory = await store.list({ includeBody: true, ...(signal ? { signal } : {}) });
  if (inventory.coverage !== 'complete') throw Object.assign(new Error('Skill library unavailable'), { code: 'catalog_unavailable' });
  const items: Array<{ id: string; name: string }> = [];
  for (const artifact of inventory.items) {
    const header = PromptBundleArtifactHeaderV1Schema.safeParse(artifact.header);
    if (artifact.header.bundleSchemaId !== 'skills.skill_md_v1') continue;
    if (!header.success) throw Object.assign(new Error('Skill header unavailable'), { code: 'catalog_unavailable' });
    let value: unknown;
    try { value = typeof artifact.body === 'string' ? JSON.parse(artifact.body) : null; } catch { value = null; }
    const body = PromptBundleBodyV1Schema.safeParse(value);
    const entry = body.success ? body.data.entries.find(entry => entry.path === 'SKILL.md' && entry.contentKind === 'utf8') : undefined;
    if (!entry) throw Object.assign(new Error('Skill content unavailable'), { code: 'catalog_unavailable' });
    const name = readSkillFrontmatterV1(new TextDecoder().decode(decodeBase64(entry.contentBase64, 'base64'))).name?.trim();
    if (!name) throw Object.assign(new Error('Skill name unavailable'), { code: 'catalog_unavailable' });
    items.push({ id: artifact.artifactId, name });
  }
  return items;
}
