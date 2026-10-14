import { describe, expect, it, vi } from 'vitest';
import { PromptStackEntryV1StoredSchema } from '../promptStacksV1.js';
import { convertStackSkillEntriesV1, appendMigratedStackSkillRulesV1, readStackSkillIdsV1 } from './convertStackSkillEntriesV1.js';
import { SkillRuleV1Schema } from '../../../reach/reachRuleV1.js';
import predecessorPickerStack from '../../../../fixtures/0.2-picker-skill-instructions-stack.json';
import { applyReachRulesChangeV1 } from '../../../reach/reachRulesChangeV1.js';

const entries = [
  { id: 'instructions', ref: { kind: 'bundle', artifactId: 'lint' }, enabled: true, placement: 'skill_instructions', editPolicy: 'user_only' },
  { id: 'append', ref: { kind: 'bundle', artifactId: 'lint' }, enabled: true, placement: 'system_append', future: true },
  { id: 'disabled', ref: { kind: 'bundle', artifactId: 'off' }, enabled: false, placement: 'skill_instructions' },
  { id: 'generic', ref: { kind: 'bundle', artifactId: 'generic' }, enabled: true, placement: 'system_append' },
].map(entry => PromptStackEntryV1StoredSchema.parse(entry));
const skillIds = new Set(['lint', 'off']);

describe('stack skill conversion', () => {
  it('classifies independent Artifact authorities without serial head-of-line waiting', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let genericRead = false;
    const pending = readStackSkillIdsV1(entries, { readArtifact: async ref => {
      if (ref.artifactId === 'lint') await held;
      if (ref.artifactId === 'generic') genericRead = true;
      return { header: { v: 1, kind: 'prompt_bundle.v2', title: ref.artifactId,
        bundleSchemaId: ref.artifactId === 'generic' ? 'bundle.generic_v1' : 'skills.skill_md_v1' } };
    } });
    try { await vi.waitFor(() => expect(genericRead).toBe(true)); }
    finally { release(); }
    expect(await pending).toEqual({ status: 'ready', skillIds: new Set(['lint', 'off']) });
  });
  it('classifies the captured real 0.2 picker vector through tolerant stored readers', async () => {
    const stored = predecessorPickerStack.stacks.surfaces.coding.map(entry => PromptStackEntryV1StoredSchema.parse({ ...entry, future: true }));
    const read = await readStackSkillIdsV1(stored, { readArtifact: async ref =>
      predecessorPickerStack.artifacts.find(artifact => artifact.id === ref.artifactId) ?? null });
    expect(read.status).toBe('ready');
    if (read.status !== 'ready') throw new Error('Captured predecessor vector unavailable');
    expect(convertStackSkillEntriesV1(stored, { kind: 'account' }, read)).toMatchObject({
      skillIds: ['session-control-skill'], remainingEntries: stored.map(entry => entry.id === 'skill-entry'
        ? { ...entry, skillMigrationV1: true } : entry),
    });
    expect(appendMigratedStackSkillRulesV1([], stored, { kind: 'account' }, { ...read, nowMs: 100 })
      .map(rule => SkillRuleV1Schema.parse(rule))).toMatchObject([{
        id: 'migrated-stack:account:skill-entry', skillId: 'session-control-skill', target: { t: 'allMachines' }, enabled: true,
      }]);
  });
  it('retains coding custody, dedupes enabled destinations and drops voice skills without enabling disabled skills', () => {
    const account = convertStackSkillEntriesV1(entries, { kind: 'account' }, { skillIds });
    expect(account.remainingEntries).toEqual(entries.map(entry => ['instructions', 'append'].includes(entry.id)
      ? { ...entry, skillMigrationV1: true } : entry));
    expect(account.skillIds).toEqual(['lint']);
    expect(account.ruleIdFor('instructions')).toBe('migrated-stack:account:instructions');
    const project = convertStackSkillEntriesV1(entries, { kind: 'project', projectKey: 'project-a' }, { skillIds });
    expect(project.ruleIdFor('append')).toBe('migrated-stack:project:project-a:append');
    expect(convertStackSkillEntriesV1(entries, { kind: 'voice' }, { skillIds }).skillIds).toEqual([]);
    expect(convertStackSkillEntriesV1(entries, { kind: 'voice' }, { skillIds }).remainingEntries.map(entry => entry.id)).toEqual(['generic']);
    expect(convertStackSkillEntriesV1(entries, { kind: 'profile' }, { skillIds }).ruleIdFor('append')).toBeNull();
    expect(convertStackSkillEntriesV1(account.remainingEntries, { kind: 'account' }, { skillIds }).skillIds).toEqual([]);
  });
  it('preserves disabled inherited references through classification as a session exclusion', async () => {
    const inherited = [{ ...entries[2]!, id: 'inherited' }];
    const classified = await readStackSkillIdsV1(inherited, { readArtifact: async () => ({ header: {
      v: 1, kind: 'prompt_bundle.v2', title: 'Disabled skill', bundleSchemaId: 'skills.skill_md_v1' } }) });
    if (classified.status !== 'ready') throw new Error('Disabled exclusion authority unavailable');
    const result = convertStackSkillEntriesV1([], { kind: 'session' }, { ...classified,
      disabledInheritedEntryIds: ['inherited'], disabledInheritedEntries: inherited });
    expect(result.excludedSkillIds).toEqual(['off']);
  });
  it('preserves a retained inherited exclusion after its migrated rule is removed and recreated', () => {
    const initial = appendMigratedStackSkillRulesV1([], entries.slice(0, 1), { kind: 'account' }, { skillIds, nowMs: 1 });
    const removed = applyReachRulesChangeV1(initial, { kind: 'write', write: { place: { t: 'allMachines' }, state: 'inherit' } },
      { nowMs: 2, newId: () => 'new-rule' });
    const replaced = applyReachRulesChangeV1(removed, { kind: 'write', write: { place: { t: 'allMachines' }, state: 'on' } },
      { nowMs: 3, newId: () => 'new-rule' }).map(rule => ({ ...rule, skillId: 'lint' }));
    expect(replaced[0]?.id).toBe('new-rule');
    const inherited = convertStackSkillEntriesV1(entries.slice(0, 1), { kind: 'account' }, { skillIds }).remainingEntries;
    expect(convertStackSkillEntriesV1([], { kind: 'session' }, { skillIds,
      disabledInheritedEntries: inherited, disabledInheritedEntryIds: ['instructions'] }).excludedSkillIds).toEqual(['lint']);
  });
  it('appends strict deterministic rules without replacing a current On/Off choice or duplicating one place', () => {
    const rules = appendMigratedStackSkillRulesV1([], entries, { kind: 'project', projectKey: 'project-a' }, { skillIds, nowMs: 100 });
    expect(rules.map(rule => SkillRuleV1Schema.parse(rule))).toEqual([{
      id: 'migrated-stack:project:project-a:instructions', skillId: 'lint', target: { t: 'project', projectKey: 'project-a' },
      enabled: true, createdAt: 100, updatedAt: 100,
    }]);
    const off = [{ ...rules[0]!, id: 'user-rule', enabled: false }];
    expect(appendMigratedStackSkillRulesV1(off, entries, { kind: 'project', projectKey: 'project-a' }, { skillIds, nowMs: 200 })).toEqual(off);
  });
  it('refuses an unreadable candidate rather than dropping its source and resolves generic headers accurately', async () => {
    expect(await readStackSkillIdsV1(entries, { readArtifact: async () => null })).toEqual({ status: 'unavailable' });
    const read = await readStackSkillIdsV1(entries, { readArtifact: async ref => ({ header: {
      v: 1, kind: 'prompt_bundle.v2', title: ref.artifactId,
      bundleSchemaId: ref.artifactId === 'generic' ? 'bundle.generic_v1' : 'skills.skill_md_v1', future: true,
    } }) });
    expect(read.status).toBe('ready');
    if (read.status === 'ready') expect([...read.skillIds]).toEqual(['lint', 'off']);
  });
});
