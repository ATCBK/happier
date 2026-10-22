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
  it('uses approved Session origin only for omitted skill defaults, preserving explicit reach and MCP defaults', () => {
    const caller = { surface: 'ui' as const, sessionId: 'focused-session', approvedActionReplay: {
      artifactId: 'approval', origin: { surface: 'agent' as const,
        caller: { kind: 'session' as const, sessionId: 'creating-session', starterDepth: 0, turnDepth: 0 } },
    } };
    expect(resolveCreateReachV1({ kind: 'skill', caller, ctx })).toEqual({ ok: true, rules: [], includeInSessionId: 'creating-session' });
    const requested = { kind: 'write', write: { place: { t: 'machine', machineId: 'chosen' }, state: 'on' } } as const;
    expect(resolveCreateReachV1({ kind: 'skill', caller, requested, ctx })).toMatchObject({ ok: true,
      rules: [{ target: { t: 'machine', machineId: 'chosen' } }], includeInSessionId: null });
    expect(resolveCreateReachV1({ kind: 'mcp_server', caller, ctx })).toMatchObject({ ok: true,
      rules: [{ target: { t: 'allMachines' } }], includeInSessionId: null });
  });
  it('does not mistake present-user Session focus for Session-origin creation', () => {
    const focused = { surface: 'ui' as const, sessionId: 'focused-session' };
    const expected = resolveCreateReachV1({ kind: 'skill', caller: { surface: 'ui' }, ctx });
    expect(resolveCreateReachV1({ kind: 'skill', caller: focused, ctx })).toEqual(expected);
    expect(resolveCreateReachV1({ kind: 'skill', caller: { ...focused, approvedActionReplay: { artifactId: 'approval',
      origin: { surface: 'ui', caller: { kind: 'host' }, sessionId: 'original-focus' } } }, ctx })).toEqual(expected);
  });
});
