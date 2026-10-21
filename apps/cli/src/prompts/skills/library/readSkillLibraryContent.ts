import { readSkillBundleContentV1,
  type PromptBundleBodyV1 } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import { computePromptBundleDigestV1 } from '@happier-dev/protocol/prompts/library/promptLibraryDigests';
import { FIRST_PARTY_SKILLS_V1 } from '@happier-dev/protocol/prompts/library/skills/firstPartySkillsV1';
import { readSkillLockV1, type SkillLibraryItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { createCredentialedAccountArtifactStore, type AccountArtifact, type AccountArtifactHeader } from '@/api/artifacts/accountArtifactStore';
import type { StoredCredentials } from '@/persistence';
import { readCompleteSkillLibraryInventoryV1 } from '@happier-dev/protocol/prompts/library/skills/readSkillLibraryCatalog';

export type SkillLibraryContent = Readonly<{ item: SkillLibraryItemV1; body: PromptBundleBodyV1 }>;
export type SkillArtifactStore = Pick<ReturnType<typeof createCredentialedAccountArtifactStore>, 'list' | 'read'>
  & Partial<Pick<ReturnType<typeof createCredentialedAccountArtifactStore>, 'readBodies'>>;

/** Opened Artifact bodies retain their canonical bundle validation and digest owner. */
export function readSkillArtifactContent(artifact: Pick<AccountArtifact, 'artifactId' | 'header' | 'body' | 'updatedAt'>): SkillLibraryContent | null {
  const content = readSkillBundleContentV1(artifact);
  if (!content) return null;
  const { frontmatter } = content;
  let sourceFolderName: string | undefined;
  try { sourceFolderName = readSkillLockV1(artifact.header).sourceFolderName; }
  catch { return null; }
  return { item: { ...frontmatter, name: frontmatter.name, description: frontmatter.description ?? '',
    ...(sourceFolderName ? { sourceFolderName } : {}),
    skillId: artifact.artifactId, digest: content.digest, updatedAt: artifact.updatedAt }, body: content.body };
}

/** Header-only inventory lets P2 select ids before any skill's content is opened. */
export async function readSkillLibraryInventory(store: SkillArtifactStore, signal?: AbortSignal): Promise<readonly AccountArtifactHeader[]> {
  return readCompleteSkillLibraryInventoryV1(store, { includeBody: false, signal });
}

/** Complete Artifact-library and first-party marks; plugin caches are retained by live Session/Run pins. */
export async function readSkillLibraryDigests(credentials: StoredCredentials): Promise<readonly string[] | null> {
  try {
    const store = createCredentialedAccountArtifactStore(credentials);
    const inventory = await readCompleteSkillLibraryInventoryV1(store, { includeBody: true });
    const digests: string[] = [];
    for (const artifact of inventory) {
      const content = readSkillBundleContentV1(artifact);
      if (!content) return null;
      digests.push(content.digest);
    }
    for (const stub of FIRST_PARTY_SKILLS_V1) digests.push(computePromptBundleDigestV1({ v: 1, entries: [...stub.files], createdAtMs: 0, updatedAtMs: 0 }));
    return digests;
  } catch { return null; }
}
