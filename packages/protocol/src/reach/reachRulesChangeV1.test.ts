import { describe, expect, it } from 'vitest';
import { applyReachRulesChangeV1 } from './reachRulesChangeV1.js';
import type { ReachRuleV1 } from './reachRuleV1.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';

describe('applyReachRulesChangeV1', () => {
  const existing: ReachRuleV1 = { id: 'original', target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 2 };
  it('preserves identities and timestamps on unchanged rules, stamps only changes, and inherits by removal', () => {
    const ctx = { nowMs: 10, newId: () => 'new' };
    expect(applyReachRulesChangeV1([existing], { kind: 'replace', rules: [{ target: { t: 'allMachines' }, enabled: true }] }, ctx)).toEqual([existing]);
    const changed = applyReachRulesChangeV1([existing], { kind: 'write', write: { place: { t: 'allMachines' }, state: 'off' } }, ctx);
    expect(changed).toEqual([{ ...existing, enabled: false, updatedAt: 10 }]);
    expect(applyReachRulesChangeV1(changed, { kind: 'write', write: { place: { t: 'allMachines' }, state: 'inherit' } }, ctx)).toEqual([]);
    expect(applyReachRulesChangeV1([existing], { kind: 'write', write: { place: { t: 'machine', machineId: 'm' }, agentId: 'gemini', state: 'off' } }, ctx)).toEqual([existing, { id: 'new', target: { t: 'machine', machineId: 'm' }, agentId: 'gemini', enabled: false, createdAt: 10, updatedAt: 10 }]);
    expect(StrictJsonValueSchema.safeParse(applyReachRulesChangeV1([], { kind: 'write', write: { place: { t: 'allMachines' }, state: 'on' } }, ctx)).success).toBe(true);
  });
  it('normalizes predecessor duplicate places using their winning rule', () => {
    const duplicates = [existing, { ...existing, id: 'newer', enabled: false, updatedAt: 3 }];
    expect(applyReachRulesChangeV1(duplicates, { kind: 'write', write: { place: { t: 'machine', machineId: 'm' }, state: 'on' } }, { nowMs: 10, newId: () => 'new' })).toEqual([duplicates[1], { id: 'new', target: { t: 'machine', machineId: 'm' }, enabled: true, createdAt: 10, updatedAt: 10 }]);
  });
});
