import { describe, expect, it } from 'vitest';
import { listActionSpecs } from './actionSpecs.js';

describe('Find/Search/Prompt authoring parity', () => {
  it('admits explicit conversation retry while keeping omitted retry and strict inputs compatible', () => {
    const spec = listActionSpecs().find(entry => entry.id === 'search.conversations')!;
    const query = { v: 1, query: 'needle', scope: { type: 'global' }, mode: 'auto' };
    expect(spec.inputSchema.parse({ query })).toEqual({ query, mode: 'auto' });
    expect(spec.inputSchema.parse({ query, retryUnreachableMachines: true }))
      .toEqual({ query, mode: 'auto', retryUnreachableMachines: true });
    expect(spec.inputSchema.safeParse({ query, retryUnreachableMachines: 'true' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ query, retry: true }).success).toBe(false);
  });
  it('exposes shortcut creation to agents and plugins through the approval-owned client path', () => {
    const spec = listActionSpecs().find(entry => entry.id === 'prompts.invocation.create');
    expect(spec).toMatchObject({ safety: 'danger', executionPlacement: 'client', surfaces: { agent: true, mcp: true, ui: true, plugin: true }, approval: { result: 'required' } });
    expect(spec?.inputSchema.safeParse({ token: 'summarise', title: 'Summarise', target: { kind: 'doc', artifactId: 'doc', serverId: 'home' } }).success).toBe(true);
  });
  it('admits an exact native History hit as private launch input on the existing workspace opener', () => {
    const spec = listActionSpecs().find(entry => entry.id === 'workspace.tabs.open');
    expect(spec?.inputSchema.safeParse({ href: '/session/linked?serverId=home', find: {
      query: 'needle', target: { kind: 'native-message', agentId: 'claude', remoteSessionId: 'native', sourceItemId: 'item' },
    } }).success).toBe(true);
  });
});
