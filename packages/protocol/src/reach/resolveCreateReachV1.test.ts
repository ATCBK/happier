import { describe, expect, it } from 'vitest';
import { resolveCreateReachV1 } from './reachRulesChangeV1.js';

const ctx = { nowMs: 10, newId: () => 'rule' };

describe('resolveCreateReachV1', () => {
  it.each(['ui', 'cli', 'mcp', 'rpc'] as const)('gives %s-created items the canonical Everywhere default', surface => {
    expect(resolveCreateReachV1({ kind: 'skill', caller: { surface }, ctx })).toEqual({ ok: true, rules: [{ id: 'rule', target: { t: 'allMachines' }, enabled: true, createdAt: 10, updatedAt: 10 }], includeInSessionId: null });
  });
  it.each(['agent', null] as const)('limits an Agent or unresolved caller to its Session', surface => {
    expect(resolveCreateReachV1({ kind: 'skill', caller: { surface, sessionId: 's' }, ctx })).toEqual({ ok: true, rules: [], includeInSessionId: 's' });
    expect(resolveCreateReachV1({ kind: 'skill', caller: { surface }, ctx })).toEqual({ ok: true, rules: [], includeInSessionId: null });
    expect(resolveCreateReachV1({ kind: 'skill', caller: { surface, sessionId: 's' }, requested: { kind: 'write', write: { place: { t: 'allMachines' }, state: 'on' } }, ctx })).toEqual({ ok: false, code: 'where_needs_rules_action' });
  });
  it('keeps MCP creation defaults for Agent callers and preserves deterministic host ids', () => {
    expect(resolveCreateReachV1({ kind: 'mcp_server', caller: { surface: 'agent', sessionId: 's' }, ctx })).toMatchObject({ ok: true, rules: [{ id: 'rule', enabled: true }], includeInSessionId: null });
    expect(resolveCreateReachV1({ kind: 'mcp_server', caller: { surface: 'rpc' }, ctx })).toEqual(resolveCreateReachV1({ kind: 'mcp_server', caller: { surface: 'rpc' }, ctx }));
  });
});
