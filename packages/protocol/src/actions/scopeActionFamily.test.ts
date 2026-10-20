import { describe, expect, it } from 'vitest';
import { ScopeActionInputSchemas, ScopeActionOutputSchemas } from './scopeActionFamily.js';
import { SCOPE_ACTION_SPECS } from './specs/scope.js';

describe('File page client view contract', () => {
  it('admits named view controls and rejects unknown controls rather than dropping them', () => {
    const schema = ScopeActionInputSchemas['file.view.set'];
    expect(schema?.safeParse({ tabId: 'file:src/a.ts', mode: 'edit', blame: true, changesScope: { kind: 'turn', turnId: 'turn-a' } }).success).toBe(true);
    expect(schema?.safeParse({ changesScope: { kind: 'mystery' } }).success).toBe(false);
    expect(schema?.safeParse({ mode: 'compare' }).success).toBe(false);
    expect(schema?.safeParse({ track: true }).success).toBe(false);
  });
});
import { getActionSpec } from './actionSpecs.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';

describe('Workflow Library client view contract', () => {
  it('admits closed mounted editor commands and requires agent approval', () => {
    expect(ScopeActionInputSchemas['file.editor.save'].parse({ tabId: 'file-a' })).toEqual({ tabId: 'file-a' });
    expect(ScopeActionInputSchemas['file.editor.save'].safeParse({ path: '/another/file' }).success).toBe(false);
    expect(ScopeActionInputSchemas['file.editor.resolve'].safeParse({ resolution: 'overwrite' }).success).toBe(false);
    for (const id of ['file.editor.save', 'file.editor.resolve'] as const) {
      const spec = getActionSpec(id);
      for (const surface of ['agent', 'mcp', 'cli'] as const) {
        expect(isApprovalRequiredByActionsSettings(id, { v: 1, actions: {} }, { surface, authority: 'account_automation' })).toBe(true);
      }
      expect(spec.executionPlacement).toBe('client');
      expect(ScopeActionOutputSchemas[id].parse({ status: 'unavailable' })).toEqual({ status: 'unavailable' });
      expect(ScopeActionOutputSchemas[id].safeParse({ status: 'unavailable', hidden: true }).success).toBe(false);
    }
  });
  it('addresses every shell column while retaining the legacy navigation input', () => {
    expect(ScopeActionInputSchemas['shell.column.get'].parse({})).toEqual({});
    expect(ScopeActionInputSchemas['shell.column.set'].parse({ visible: true })).toEqual({ visible: true });
    expect(ScopeActionInputSchemas['shell.column.set'].parse({ column: 'side', visible: false, tab: 'files' }))
      .toEqual({ column: 'side', visible: false, tab: 'files' });
    expect(ScopeActionInputSchemas['shell.column.get'].safeParse({ column: 'other' }).success).toBe(false);
    const projection = { present: true, visible: false, available: true, tabs: ['files', 'plugin:notes'], activeTab: 'files', label: 'Session' };
    expect(ScopeActionOutputSchemas['shell.column.get'].parse(projection)).toEqual(projection);
  });
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
