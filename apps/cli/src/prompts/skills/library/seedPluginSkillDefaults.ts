import { mutateSkillRulesV1, type SkillRulesActionPortV1 } from '@happier-dev/protocol/prompts/library/skillRulesActionsV1';
import { readPromptLibraryCatalogRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import type { ReadOnlySkillV1 } from '@happier-dev/protocol/prompts/library/skills/firstPartySkillsV1';
import { resolveCreateReachV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';

/** Durable install publication alone seeds defaults; reads and enable never write reach. */
export async function seedPluginSkillDefaults(input: Readonly<{
  skills: readonly ReadOnlySkillV1[]; port: SkillRulesActionPortV1;
}>): Promise<void> {
  if (input.skills.length === 0) return;
  const projection = await input.port.readCatalog(undefined, 'skill-rules');
  input.port.assertCurrent();
  const read = readPromptLibraryCatalogRecordV1({ ...projection, key: 'skill-rules' });
  if (read.status !== 'ready' || read.record.key !== 'skill-rules') throw new Error('skill_rules_unavailable');
  const existingRules = read.record.value.rules;
  const items = input.skills.filter(skill => !existingRules.some(rule => rule.skillId === skill.skillId))
    .map(skill => ({ skillId: skill.skillId }));
  if (items.length === 0) return;
  const defaults = resolveCreateReachV1({ kind: 'skill', caller: { surface: 'rpc' }, ctx: input.port.ruleWriteContext() });
  if (!defaults.ok || defaults.rules.length !== 1) throw new Error('skill_plugin_defaults_unavailable');
  const rule = defaults.rules[0]!;
  const receipt = await mutateSkillRulesV1(input.port, { items, change: { kind: 'write',
    write: { place: rule.target, state: rule.enabled ? 'on' : 'off', ...(rule.agentId ? { agentId: rule.agentId } : {}) } } });
  if (!receipt.ok) throw new Error(`skill_plugin_defaults_${receipt.code}`);
}
