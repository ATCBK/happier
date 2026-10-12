import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import type { ArtifactFolderActionPortV1 } from '../prompts/library/promptFolderActionsV1.js';
import type { SkillRuleV1 } from '../reach/reachRuleV1.js';

const original: SkillRuleV1 = { id: 'existing', skillId: 'lint-id', target: { t: 'allMachines' }, enabled: false, createdAt: 1, updatedAt: 2 };
const { skillId: _skillId, ...previous } = original;
const request = { items: [{ name: 'lint' }, { skillId: 'review-id' }],
  change: { kind: 'write', write: { place: { t: 'allMachines' }, state: 'on' } } };
function fixture(options: { unavailable?: boolean; conflict?: boolean; inactive?: boolean; sourceCurrentness?: boolean } = {}) {
  let rules = [original];
  const writes: Array<Parameters<ArtifactFolderActionPortV1['writeRecord']>[0]> = [];
  const port = {
    serverId: 'home', assertCurrent: () => {},
    readCatalog: async () => ({ catalog: options.unavailable
      ? { status: 'partial' as const, rows: [], tombstones: [], diagnostics: [{ key: 'skill-rules' as const, revision: 3, reason: 'invalid-stored-content' as const }] }
      : { status: 'ready' as const, rows: options.inactive ? [] : [{ record: { key: 'skill-rules' as const, value: { v: 1 as const, rules } }, revision: 3 }], tombstones: [], diagnostics: [] },
      ...(options.inactive ? { rawSettings: {}, ...(options.sourceCurrentness ? { sourceSettingsVersion: 7 } : {}) } : {}) }),
    writeRecord: async (input: Parameters<ArtifactFolderActionPortV1['writeRecord']>[0]) => {
      writes.push(input);
      if (options.conflict) return { status: 'conflict' as const, revision: 4 };
      if (input.record.key === 'skill-rules') rules = input.record.value.rules;
      return { status: 'updated' as const, revision: 4, cursor: 1 };
    },
    listSkills: async () => [{ id: 'lint-id', name: 'lint' }, { id: 'review-id', name: 'review' }],
    ruleWriteContext: () => ({ nowMs: 8, newId: () => 'new' }),
  };
  const deps = { isActionApprovalRequired: () => false, skillRules: port } satisfies ActionExecutorDeps;
  return { executor: createActionExecutor(deps), writes, rules: () => rules };
}
describe('skill rules Action through prompt-library CAS', () => {
  it('resolves names and ids and writes every item atomically with the previous rules for Undo', async () => {
    const f = fixture();
    expect(await f.executor.execute('skills.rules.set', request, { surface: 'ui', serverId: 'home' })).toEqual({ ok: true, result: {
      ok: true, revision: 4, items: [
        { skillId: 'lint-id', previous: [previous], rules: [{ ...previous, enabled: true, updatedAt: 8 }] },
        { skillId: 'review-id', previous: [], rules: [{ id: 'new', target: { t: 'allMachines' }, enabled: true, createdAt: 8, updatedAt: 8 }] },
      ],
    } });
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]?.expectedRevision).toBe(3);
    expect(f.rules().map(rule => rule.skillId)).toEqual(['lint-id', 'review-id']);
  });
  it.each([{ unavailable: true }, { inactive: true }])('refuses unreadable rules or missing captured source currentness', async options => {
    const f = fixture(options);
    expect(await f.executor.execute('skills.rules.set', request, { surface: 'ui' })).toEqual({ ok: true, result: { ok: false, code: 'catalog_unavailable' } });
    expect(f.writes).toEqual([]);
  });
  it('returns a lost CAS as conflict without replaying or publishing success', async () => {
    const f = fixture({ conflict: true });
    expect(await f.executor.execute('skills.rules.set', request, { surface: 'ui' })).toEqual({ ok: true, result: { ok: false, code: 'conflict' } });
    expect(f.rules()).toEqual([original]);
    expect(f.writes).toHaveLength(1);
  });
  it('refuses missing items and multi-item replacement without writing any item', async () => {
    const f = fixture();
    expect(await f.executor.execute('skills.rules.set', { ...request, items: [{ name: 'missing' }] }, { surface: 'ui' }))
      .toEqual({ ok: true, result: { ok: false, code: 'not_found' } });
    expect(await f.executor.execute('skills.rules.set', { ...request, change: { kind: 'replace', rules: [] } }, { surface: 'ui' }))
      .toEqual({ ok: true, result: { ok: false, code: 'replace_needs_one_item' } });
    expect(f.writes).toEqual([]);
  });
});
