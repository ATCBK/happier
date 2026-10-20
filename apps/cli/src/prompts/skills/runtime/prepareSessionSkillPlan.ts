import type { PluginAgentSkillsCapabilityV2 } from '@happier-dev/protocol';
import type { AccountArtifactHeader } from '@/api/artifacts/accountArtifactStore';
import { isPluginSkillIdV1, type SkillLibraryItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import type { ResolveSessionCapabilitiesV1Result } from '@happier-dev/protocol/reach/resolveSessionCapabilitiesV1';
import { FIRST_PARTY_SKILLS_V1, type ReadOnlySkillV1 } from '@happier-dev/protocol/prompts/library/skills/firstPartySkillsV1';
import { readReadOnlySkillContentV1 } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import { resolveSessionSkillPlanV1 } from '@happier-dev/protocol/prompts/library/skills/resolveSessionSkillPlanV1';
import { readSkillArtifactContent, type SkillArtifactStore, type SkillLibraryContent } from '../library/readSkillLibraryContent';
import { scanNativeSkillRoots } from '../native/scanNativeSkillRoots';
import { traceSkillPreparationPhase } from './traceSkillPreparationPhase';

/** Read-only preparation shared by machine previews and the runner's folder producer. */
export async function prepareSessionSkillPlan(input: Readonly<{
  inventory?: readonly AccountArtifactHeader[];
  pluginSkills?: readonly ReadOnlySkillV1[];
  artifacts: SkillArtifactStore;
  selected: ResolveSessionCapabilitiesV1Result['skills'];
  agentSkills: PluginAgentSkillsCapabilityV2;
  agentHasActionChannel: boolean;
  directory: string | null;
  additionalProjectDirectories?: readonly string[];
  purpose?: 'preview' | 'start' | 'reapply';
  home?: string;
  signal?: AbortSignal;
  assertCurrent: () => Promise<void>;
}>) {
  const selectedById = new Map(input.selected.items.map(item => [item.id, item]));
  const contents = new Map<string, SkillLibraryContent>();
  const unreadable = new Set<string>();
  const items: SkillLibraryItemV1[] = [];
  // Previews supply their complete choice inventory. Runners already know
  // demand from Reach/Session selection and open those exact references.
  const artifactItems = input.inventory?.map(artifact => ({ skillId: artifact.artifactId,
    name: String(artifact.header.title), updatedAt: artifact.updatedAt }))
    ?? input.selected.items.filter(item => !isPluginSkillIdV1(item.id)
      && !FIRST_PARTY_SKILLS_V1.some(skill => skill.skillId === item.id))
      .map(item => ({ skillId: item.id, name: item.name, updatedAt: undefined }));
  // A preview already has headers: open selected bodies through the Artifact
  // owner's batch projection, retaining refused identities as unreadable.
  const opened = await traceSkillPreparationPhase('selected_artifact_content', async () => {
    if (input.inventory && input.artifacts.readBodies) {
      const selected = input.inventory.filter(item => selectedById.get(item.artifactId)?.selected);
      const bodies = await input.artifacts.readBodies(selected, input.signal).catch(() => []);
      await input.assertCurrent();
      input.signal?.throwIfAborted();
      const contentById = new Map(bodies.map(item => [item.artifactId, readSkillArtifactContent({ ...item, body: item.body ?? null })]));
      return artifactItems.map(item => contentById.get(item.skillId) ?? null);
    }
    // Runner demand has no inventory; open only its exact selected references.
    return Promise.all(artifactItems.map(async item => {
      if (!selectedById.get(item.skillId)?.selected) return null;
      let content: SkillLibraryContent | null = null;
      try { const artifactContent = await input.artifacts.read(item.skillId, { signal: input.signal }); content = artifactContent ? readSkillArtifactContent(artifactContent) : null; }
      catch { content = null; }
      await input.assertCurrent();
      return content;
    }));
  });
  for (const [index, item] of artifactItems.entries()) {
    const content = opened[index];
    if (!content && selectedById.get(item.skillId)?.selected) unreadable.add(item.skillId);
    if (content) { contents.set(item.skillId, content); items.push(content.item); }
    else items.push({ ...item, digest: '', description: '', disableModelInvocation: false, userInvocable: true });
  }
  for (const skill of [...FIRST_PARTY_SKILLS_V1, ...input.pluginSkills ?? []]) {
    let content: ReturnType<typeof readReadOnlySkillContentV1>;
    try { content = readReadOnlySkillContentV1(skill.skillId, input.pluginSkills); }
    catch (error) {
      if (selectedById.get(skill.skillId)?.selected) throw error;
      continue;
    }
    if (!content) {
      if (selectedById.get(skill.skillId)?.selected) throw new Error('skill_content_unavailable');
      continue;
    }
    const item = { ...content.frontmatter, skillId: skill.skillId, description: content.frontmatter.description ?? '', digest: content.digest };
    items.push(item); contents.set(item.skillId, { item, body: content.body });
  }
  // Only an admitted fresh start with no consumer can omit native facts. Previews
  // still need them, and reapply may have an earlier delivery to clear.
  const nativeSkills = input.purpose === 'start' && !input.selected.items.some(item => item.selected)
    && input.selected.excludeNativeSkillNames.length === 0 ? null
    : await traceSkillPreparationPhase('native_scan', () => scanNativeSkillRoots({ nativeRoots: input.agentSkills.nativeRoots, directory: input.directory, home: input.home,
      additionalProjectDirectories: input.additionalProjectDirectories }));
  await input.assertCurrent();
  const plan = resolveSessionSkillPlanV1({ items, selected: input.selected.items, excludeNativeSkillNames: input.selected.excludeNativeSkillNames,
    agentSkills: input.agentSkills, agentHasActionChannel: input.agentHasActionChannel, nativeSkills: nativeSkills ?? { status: 'ok', names: [] } });
  for (const item of plan.items) if (unreadable.has(item.skillId)) { item.state = 'unavailable'; item.reason = 'content_unreadable'; }
  return { plan, contents, nativeSkills };
}
