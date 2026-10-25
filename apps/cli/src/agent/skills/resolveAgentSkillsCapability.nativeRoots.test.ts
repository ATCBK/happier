import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { PluginAgentContributionV2Schema } from '@happier-dev/protocol';
import { PLUGIN_MANIFEST as copilot } from '@happier-dev/plugins-copilot/manifest';
import { PLUGIN_MANIFEST as qwen } from '@happier-dev/plugins-qwen/manifest';
import { PLUGIN_MANIFEST as codebuddy } from '@happier-dev/plugins-codebuddy/manifest';
import { PLUGIN_MANIFEST as devin } from '@happier-dev/plugins-devin/manifest';
import { PLUGIN_MANIFEST as antigravity } from '@happier-dev/plugins-antigravity/manifest';
import { PLUGIN_MANIFEST as kiro } from '@happier-dev/plugins-kiro/manifest';
import { PLUGIN_MANIFEST as kimi } from '@happier-dev/plugins-kimi/manifest';
import { PLUGIN_MANIFEST as fx } from '@happier-dev/plugins-fx/manifest';
import { PLUGIN_MANIFEST as droid } from '@happier-dev/plugins-droid/manifest';
import { PLUGIN_MANIFEST as auggie } from '@happier-dev/plugins-auggie/manifest';

import { scanNativeSkillRoots } from '@/prompts/skills/native/scanNativeSkillRoots';
import { withTempDir } from '@/testkit/fs/tempDir';

const cases = [
  { manifest: copilot, delivery: 'session_dir', roots: ['.copilot/skills', '.agents/skills'], project: ['.github/skills', '.agents/skills', '.claude/skills'] },
  { manifest: qwen, delivery: 'session_dir', roots: ['.qwen/skills', '.agents/skills'], project: ['.qwen/skills', '.agents/skills'] },
  { manifest: codebuddy, delivery: 'session_dir', roots: ['.codebuddy/skills'], project: ['.codebuddy/skills'] },
  { manifest: devin, delivery: 'session_dir', roots: ['.config/devin/skills', '.agents/skills'], project: ['.devin/skills', '.agents/skills', '.windsurf/skills'] },
  { manifest: antigravity, delivery: 'none', roots: ['.gemini/antigravity-cli/skills'], project: ['.gemini/skills', '.agents/skills'] },
  { manifest: kiro, delivery: 'none', roots: ['.kiro/skills'], project: ['.kiro/skills'] },
  { manifest: kimi, delivery: 'none', roots: ['.config/agents/skills', '.agents/skills', '.kimi/skills', '.claude/skills', '.codex/skills'], project: ['.agents/skills', '.kimi/skills', '.claude/skills', '.codex/skills'] },
  { manifest: fx, delivery: 'none', roots: ['.fx/skills', '.config/opencode/skills', '.codex/skills', '.claude/skills', '.agents/skills', '.claw/skills'], project: ['.fx/skills', 'skills', '.opencode/skills', '.codex/skills', '.claude/skills', '.agents/skills', '.claw/skills'] },
  { manifest: droid, delivery: 'none', roots: ['.factory/skills', '.agents/skills', '.agent/skills'], project: ['.factory/skills', '.agents/skills', '.agent/skills'] },
  { manifest: auggie, delivery: 'session_dir', roots: ['.augment/skills', '.claude/skills', '.agents/skills'], project: ['.augment/skills', '.claude/skills', '.agents/skills'] },
] as const;

it.each(cases)('discovers the declared native roots of $manifest.id while retaining its declared skill delivery', async ({ manifest, delivery, roots, project }) => {
  await withTempDir('happier-acp-native-root-contract-', async dir => {
    const home = join(dir, 'home'); const cwd = join(dir, 'project');
    await mkdir(join(cwd, '.git'), { recursive: true });
    const expected = [...roots.map(root => join(home, ...root.split('/'))), ...project.map(root => join(cwd, ...root.split('/')))];
    for (const [index, root] of expected.entries()) {
      await mkdir(join(root, `native-${index}`), { recursive: true });
      await writeFile(join(root, `native-${index}`, 'SKILL.md'), `---\nname: native-${index}\ndescription: Native root fixture\n---\nInstructions\n`);
    }
    const agent = PluginAgentContributionV2Schema.parse(manifest.contributes.agents?.[0]);
    const skills = 'skills' in agent.capabilities ? agent.capabilities.skills : undefined;
    expect(skills?.delivery).toBe(delivery);
    const scan = await scanNativeSkillRoots({ nativeRoots: skills?.nativeRoots, home, directory: cwd });
    expect(scan.status).toBe('ok');
    expect(scan.names.map(item => item.root).sort()).toEqual(expected.sort());
    if ('runtime' in agent && agent.runtime.kind === 'acp') {
      const definitionSkills = agent.runtime.definition?.skills;
      if (delivery === 'none') expect(definitionSkills).toBeUndefined();
      else expect(Object.keys(definitionSkills ?? {}).filter(key => key !== 'sessionDelivery')).toEqual([]);
    }
  });
});
