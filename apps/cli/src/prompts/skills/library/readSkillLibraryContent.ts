import { PromptBundleArtifactHeaderV1Schema, PromptBundleBodyV1Schema, validatePromptBundleBodyV1AgainstSchemaId,
  type PromptBundleBodyV1 } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import { computePromptBundleDigestV1 } from '@happier-dev/protocol/prompts/library/promptLibraryDigests';
import { FIRST_PARTY_SKILLS_V1 } from '@happier-dev/protocol/prompts/library/skills/firstPartySkillsV1';
import { readSkillFrontmatterV1, type SkillLibraryItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { createCredentialedAccountArtifactStore, type AccountArtifact, type AccountArtifactHeader } from '@/api/artifacts/accountArtifactStore';
import type { StoredCredentials } from '@/persistence';

export type SkillLibraryContent = Readonly<{ item: SkillLibraryItemV1; body: PromptBundleBodyV1 }>;
export type SkillArtifactStore = Pick<ReturnType<typeof createCredentialedAccountArtifactStore>, 'list' | 'read'>;

/** Opened Artifact bodies retain their canonical bundle validation and digest owner. */
export function readSkillArtifactContent(artifact: Pick<AccountArtifact, 'artifactId' | 'header' | 'body' | 'updatedAt'>): SkillLibraryContent | null {
  const header = PromptBundleArtifactHeaderV1Schema.safeParse(artifact.header);
  if (!header.success || header.data.bundleSchemaId !== 'skills.skill_md_v1' || typeof artifact.body !== 'string') return null;
  let raw: unknown;
  try { raw = JSON.parse(artifact.body); } catch { return null; }
  const body = PromptBundleBodyV1Schema.safeParse(raw);
  if (!body.success || !validatePromptBundleBodyV1AgainstSchemaId({ bundleSchemaId: header.data.bundleSchemaId, body: body.data }).ok) return null;
  const skillMd = body.data.entries.find(entry => entry.path === 'SKILL.md' && entry.contentKind === 'utf8');
  if (!skillMd) return null;
  const frontmatter = readSkillFrontmatterV1(Buffer.from(skillMd.contentBase64, 'base64').toString('utf8'));
  if (!frontmatter.name) return null;
  return { item: { ...frontmatter, name: frontmatter.name, description: frontmatter.description ?? '',
    skillId: artifact.artifactId, digest: computePromptBundleDigestV1(body.data), updatedAt: artifact.updatedAt }, body: body.data };
}

/** Header-only inventory lets P2 select ids before any skill's content is opened. */
export async function readSkillLibraryInventory(store: SkillArtifactStore): Promise<readonly AccountArtifactHeader[]> {
  const inventory = await store.list({ kind: 'prompt_bundle.v2', includeBody: false });
  if (inventory.coverage !== 'complete') throw Object.assign(new Error('Skill library unavailable'), { code: 'catalog_unavailable' });
  return inventory.items.filter(artifact => artifact.header.bundleSchemaId === 'skills.skill_md_v1').map(artifact => {
    if (!PromptBundleArtifactHeaderV1Schema.safeParse(artifact.header).success) {
      throw Object.assign(new Error('Skill header unavailable'), { code: 'catalog_unavailable' });
    }
    return artifact;
  });
}

/** A failed body or incomplete inventory cannot authorize the daemon GC sweep. */
export async function readSkillLibraryDigests(credentials: StoredCredentials): Promise<readonly string[] | null> {
  try {
    const store = createCredentialedAccountArtifactStore(credentials);
    const headers = await readSkillLibraryInventory(store);
    const digests: string[] = [];
    for (const header of headers) {
      const artifact = await store.read(header.artifactId);
      const content = artifact ? readSkillArtifactContent(artifact) : null;
      if (!content) return null;
      digests.push(content.item.digest);
    }
    for (const stub of FIRST_PARTY_SKILLS_V1) digests.push(computePromptBundleDigestV1({ v: 1, entries: [...stub.files], createdAtMs: 0, updatedAtMs: 0 }));
    return digests;
  } catch { return null; }
}
