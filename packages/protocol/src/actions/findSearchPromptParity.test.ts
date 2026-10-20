import { describe, expect, it } from 'vitest';
import { listActionSpecs } from './actionSpecs.js';

describe('Find/Search/Prompt authoring parity', () => {
  it.each(['prompt_doc.get', 'prompt_doc.create', 'prompt_doc.update', 'prompt_doc.favorite.set',
    'prompts.library.list', 'prompts.invocations.list', 'prompts.invocation.resolve',
    'prompts.invocation.create', 'prompts.invocation.update', 'prompts.invocation.delete'])(
    'keeps %s at the Account owner for headless approval replay', actionId => {
      expect(listActionSpecs().find(entry => entry.id === actionId)).toMatchObject({
        executionPlacement: 'account', surfaces: { ui: true, cli: true, mcp: true, agent: true },
      });
    });
  it('admits explicit conversation retry while keeping omitted retry and strict inputs compatible', () => {
    const spec = listActionSpecs().find(entry => entry.id === 'search.conversations')!;
    const query = { v: 1, query: 'needle', scope: { type: 'global' }, mode: 'auto' };
    expect(spec.inputSchema.parse({ query })).toEqual({ query, mode: 'auto' });
    expect(spec.inputSchema.parse({ query, retryUnreachableMachines: true }))
      .toEqual({ query, mode: 'auto', retryUnreachableMachines: true });
    expect(spec.inputSchema.safeParse({ query, retryUnreachableMachines: 'true' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ query, retry: true }).success).toBe(false);
  });
  it('exposes shortcut creation to agents and plugins through the approval-owned Account path', () => {
    const spec = listActionSpecs().find(entry => entry.id === 'prompts.invocation.create');
    expect(spec).toMatchObject({ safety: 'danger', executionPlacement: 'account', surfaces: { agent: true, mcp: true, ui: true, plugin: true }, approval: { result: 'required' } });
    expect(spec?.inputSchema.safeParse({ token: 'summarise', title: 'Summarise', target: { kind: 'doc', artifactId: 'doc', serverId: 'home' } }).success).toBe(true);
  });
  it.each(['prompts.invocation.create', 'prompts.invocation.update', 'prompts.invocation.delete'])(
    'exposes %s to CLI and MCP through the existing Account carrier', actionId => {
      const spec = listActionSpecs().find(entry => entry.id === actionId);
      expect(spec).toMatchObject({ executionPlacement: 'account', surfaces: { cli: true, mcp: true },
        cli: { acceptsServerId: true, commands: [] } });
    });
  it('admits an exact native History hit as private launch input on the existing workspace opener', () => {
    const spec = listActionSpecs().find(entry => entry.id === 'workspace.tabs.open');
    expect(spec?.inputSchema.safeParse({ href: '/session/linked?serverId=home', find: {
      query: 'needle', target: { kind: 'native-message', agentId: 'claude', remoteSessionId: 'native', sourceItemId: 'item' },
    } }).success).toBe(true);
  });
});
