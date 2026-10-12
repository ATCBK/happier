import type { z } from 'zod';
import { SkillsRulesSetInputV1Schema, type SkillsRulesSetOutputV1Schema } from '../../actions/specs/capabilityRules.js';
import { applyReachRulesChangeV1, type ReachRulesWriteContextV1 } from '../../reach/reachRulesChangeV1.js';
import type { ReachRuleV1 } from '../../reach/reachRuleV1.js';
import { readPromptLibraryCatalogRecordV1, type PromptLibraryStackActionPortV1 } from './promptLibraryCatalogV1.js';

export type SkillRulesActionPortV1 = PromptLibraryStackActionPortV1 & Readonly<{
  listSkills(signal?: AbortSignal): Promise<readonly Readonly<{ id: string; name: string }>[]>;
  ruleWriteContext(): ReachRulesWriteContextV1;
}>;

/** Reach intent is applied once to the reviewed row and committed by its existing CAS. */
export async function mutateSkillRulesV1(port: SkillRulesActionPortV1,
  request: z.infer<typeof SkillsRulesSetInputV1Schema>, signal?: AbortSignal,
): Promise<z.infer<typeof SkillsRulesSetOutputV1Schema>> {
  const input = SkillsRulesSetInputV1Schema.parse(request);
  if (input.change.kind === 'replace' && input.items.length !== 1) return { ok: false, code: 'replace_needs_one_item' };
  const assertCurrent = () => { signal?.throwIfAborted(); port.assertCurrent(); };
  assertCurrent();
  const projection = await port.readCatalog(signal, 'skill-rules');
  assertCurrent();
  const read = readPromptLibraryCatalogRecordV1({ ...projection, key: 'skill-rules' });
  if (read.status !== 'ready' || read.record.key !== 'skill-rules'
    || read.authority === 'inactive' && projection.sourceSettingsVersion === undefined) return { ok: false, code: 'catalog_unavailable' };
  let library: Awaited<ReturnType<SkillRulesActionPortV1['listSkills']>>;
  try { library = await port.listSkills(signal); }
  catch { assertCurrent(); return { ok: false, code: 'catalog_unavailable' }; }
  assertCurrent();
  const ids = new Set<string>();
  for (const item of input.items) {
    const matches = library.filter(skill => 'skillId' in item ? skill.id === item.skillId : skill.name === item.name);
    if (matches.length !== 1) return { ok: false, code: 'not_found' };
    ids.add(matches[0]!.id);
  }
  const ctx = port.ruleWriteContext();
  const items = [...ids].map(skillId => {
    const previous: ReachRuleV1[] = read.record.value.rules.filter(rule => rule.skillId === skillId)
      .map(({ skillId: _skillId, ...rule }) => rule);
    return { skillId, previous, rules: applyReachRulesChangeV1(previous, input.change, ctx) };
  });
  const rules = [...read.record.value.rules.filter(rule => !ids.has(rule.skillId)),
    ...items.flatMap(item => item.rules.map(rule => ({ ...rule, skillId: item.skillId })))];
  assertCurrent();
  const result = await port.writeRecord({ record: { key: 'skill-rules', value: { v: 1, rules } }, expectedRevision: read.revision,
    ...(read.authority === 'inactive' ? { sourceSettingsVersion: projection.sourceSettingsVersion } : {}) }, signal);
  // A consumed durable receipt survives subsequent caller cancellation or Home retirement.
  if (result.status === 'updated') return { ok: true, items, revision: result.revision };
  return { ok: false, code: result.status === 'conflict' || result.status === 'settings-conflict' ? 'conflict' : 'catalog_unavailable' };
}
