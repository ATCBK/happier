import { describe, expect, it } from 'vitest';
import { ScopeActionInputSchemas, ScopeActionOutputSchemas } from './scopeActionFamily.js';
import { SCOPE_ACTION_SPECS } from './specs/scope.js';

describe('Workflow Library client view contract', () => {
  it('admits typed view and query inputs without dropping query text or accepting opaque commands', () => {
    const input = ScopeActionInputSchemas['workflow.library.view.set'];
    expect(input.parse({ view: 'triggered', searchQuery: '  Release  ' })).toEqual({ view: 'triggered', searchQuery: '  Release  ' });
    expect(input.safeParse({ view: 'history' }).success).toBe(false);
    expect(input.safeParse({ searchQuery: 1 }).success).toBe(false);
    expect(input.safeParse({ view: 'running', command: { query: 'release' } }).success).toBe(false);
    expect(ScopeActionInputSchemas['workflow.library.view.get'].safeParse({ accountId: 'another-account' }).success).toBe(false);
  });

  it('keeps the observed mounted projection closed and routes all three operations to this client', () => {
    const observed = { view: 'running', searchQuery: 'release', offeredViews: ['all', 'running'], visibleKeys: ['release-notes'] };
    expect(ScopeActionOutputSchemas['workflow.library.view.get'].parse(observed)).toEqual(observed);
    expect(ScopeActionOutputSchemas['workflow.library.view.get'].safeParse({ ...observed, hiddenMembers: ['secret'] }).success).toBe(false);
    for (const id of ['workflow.library.view.get', 'workflow.library.view.set', 'workflow.library.view.reset']) {
      const spec = SCOPE_ACTION_SPECS.find(spec => spec.id === id)!;
      expect(spec.executionPlacement).toBe('client');
      expect(spec.surfaces).toMatchObject({ agent: true, mcp: true, rpc: false });
    }
  });
});
