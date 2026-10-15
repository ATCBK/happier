import type { PluginAgentSkillsCapabilityV2 } from '@happier-dev/protocol';
import type { AccountArtifactHeader } from '@/api/artifacts/accountArtifactStore';
import type { SkillLibraryItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import type { ResolveSessionCapabilitiesV1Result } from '@happier-dev/protocol/reach/resolveSessionCapabilitiesV1';
import { FIRST_PARTY_SKILLS_V1 } from '@happier-dev/protocol/prompts/library/skills/firstPartySkillsV1';
import { computePromptBundleDigestV1 } from '@happier-dev/protocol/prompts/library/promptLibraryDigests';
import { readSkillFrontmatterV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { resolveSessionSkillPlanV1 } from '@happier-dev/protocol/prompts/library/skills/resolveSessionSkillPlanV1';
import { readSkillArtifactContent, type SkillArtifactStore, type SkillLibraryContent } from '../library/readSkillLibraryContent';
import { scanNativeSkillRoots } from '../native/scanNativeSkillRoots';

/** Read-only preparation shared by machine previews and the runner's folder producer. */
export async function prepareSessionSkillPlan(input: Readonly<{
  inventory: readonly AccountArtifactHeader[];
  artifacts: SkillArtifactStore;
  selected: ResolveSessionCapabilitiesV1Result['skills'];
  agentSkills: PluginAgentSkillsCapabilityV2;
  agentHasActionChannel: boolean;
  directory: string | null;
  home?: string;
  assertCurrent: () => Promise<void>;
}>) {
  const selectedById = new Map(input.selected.items.map(item => [item.id, item]));
  const contents = new Map<string, SkillLibraryContent>();
  const unreadable = new Set<string>();
  const items: SkillLibraryItemV1[] = [];
  // Each selected Artifact has its own read/authority checks. Admit them
  // together, then resolve names in inventory order after every read settles.
  const opened = await Promise.all(input.inventory.map(async artifact => {
    if (!selectedById.get(artifact.artifactId)?.selected) return null;
    let content: SkillLibraryContent | null = null;
    try { const artifactContent = await input.artifacts.read(artifact.artifactId); content = artifactContent ? readSkillArtifactContent(artifactContent) : null; }
    catch { content = null; }
    await input.assertCurrent();
    return content;
  }));
  for (const [index, artifact] of input.inventory.entries()) {
    const content = opened[index];
    if (!content && selectedById.get(artifact.artifactId)?.selected) unreadable.add(artifact.artifactId);
    if (content) { contents.set(artifact.artifactId, content); items.push(content.item); }
    else items.push({ skillId: artifact.artifactId, name: String(artifact.header.title), digest: '', description: '',
      disableModelInvocation: false, userInvocable: true, updatedAt: artifact.updatedAt });
  }
  for (const stub of FIRST_PARTY_SKILLS_V1) {
    const body = { v: 1 as const, entries: [...stub.files], createdAtMs: 0, updatedAtMs: 0 };
    const skillMd = stub.files.find(entry => entry.path === 'SKILL.md');
    const frontmatter = readSkillFrontmatterV1(skillMd ? Buffer.from(skillMd.contentBase64, 'base64').toString('utf8') : '');
    const item = { ...frontmatter, name: stub.name, skillId: stub.skillId, description: stub.description, digest: computePromptBundleDigestV1(body) };
    items.push(item); contents.set(item.skillId, { item, body });
  }
  const nativeSkills = await scanNativeSkillRoots({ nativeRoots: input.agentSkills.nativeRoots, directory: input.directory, home: input.home });
  await input.assertCurrent();
  const plan = resolveSessionSkillPlanV1({ items, selected: input.selected.items, excludeNativeSkillNames: input.selected.excludeNativeSkillNames,
    agentSkills: input.agentSkills, agentHasActionChannel: input.agentHasActionChannel, nativeSkills });
  for (const item of plan.items) if (unreadable.has(item.skillId)) { item.state = 'unavailable'; item.reason = 'content_unreadable'; }
  return { plan, contents, nativeSkills };
}
