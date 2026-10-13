import { describe, expect, it } from 'vitest';
import { FIRST_PARTY_SKILLS_V1, buildFirstPartySkillSeedRuleV1 } from './firstPartySkillsV1.js';
import { computePromptBundleDigestV1 } from '../promptLibraryDigests.js';
import { readSkillBundleContentV1 } from '../promptBundleSchemas.js';
import { resolveSessionCapabilitiesV1 } from '../../../reach/resolveSessionCapabilitiesV1.js';
import { listActionCliCommandDeclarations } from '../../../actions/actionSpecs.js';
import { readSkillLibraryCatalog } from './readSkillLibraryCatalog.js';

describe('first-party bundled skills', () => {
  it('makes bundled identities selectable through the canonical names/ids catalog without an Artifact', async () => {
    const catalog = await readSkillLibraryCatalog({ list: async () => ({ items: [], coverage: 'complete' }) });
    expect(catalog).toContainEqual({ id: 'happier:happier', name: 'happier' });
  });
  it('supplies a valid stable stub through the same bundle and reach consumers, with guides for declared CLI roots', () => {
    const skill = FIRST_PARTY_SKILLS_V1.find(item => item.skillId === 'happier:happier');
    expect(skill).toBeDefined();
    if (!skill) throw new Error('Missing first-party stub');
    const body = { v: 1 as const, entries: [...skill.files], createdAtMs: 0, updatedAtMs: 0 };
    const content = readSkillBundleContentV1({ header: { v: 1, kind: 'prompt_bundle.v2', title: skill.description,
      bundleSchemaId: 'skills.skill_md_v1' }, body: JSON.stringify(body) });
    expect(content).not.toBeNull();
    expect(content?.frontmatter.name).toBe('happier');
    expect(content?.digest).toBe(computePromptBundleDigestV1({ ...body, updatedAtMs: 999 }));
    const roots = new Set(listActionCliCommandDeclarations().map(command => command.binding.path[0]));
    for (const root of ['skills', 'mcp', 'session']) expect(roots.has(root)).toBe(true);
    const selected = resolveSessionCapabilitiesV1({ context: { machineId: 'machine', machinePlatform: 'posix', directory: null,
      projectKey: null, agentId: 'claude' }, mcp: null, skills: { items: [skill], rules: [buildFirstPartySkillSeedRuleV1(skill.skillId, 100)] },
      selection: {}, agentAcceptsUserMcp: false });
    expect(selected.skills.items).toMatchObject([{ id: skill.skillId, selected: true }]);
  });
});
