import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { isPluginSurfaceExcludedActionId } from './pluginActionSurface.js';
import { DaemonWorkspaceFileSearchRequestSchema, DaemonWorkspaceFileSearchResponseSchema } from '../machines/workspaceFiles.js';

describe('search-backed code Actions', () => {
  it('keeps reviewed semantic writes behind real agent approval', async () => {
    const requests: unknown[] = [];
    let applied = false;
    const executor = createActionExecutor({
      languageIntelligenceApply: async () => { applied = true; return { ok: true, results: [] }; },
      approvalsCreate: async ({ request }) => { requests.push(request); return { artifactId: 'rename-approval' }; },
      approvalsUpdate: async () => ({ ok: true }),
      approvalsWaitForDecision: async ({ request }) => ({ decision: 'reject', request }),
      isActionApprovalRequired: (id, context, input) => isApprovalRequiredByActionsSettings(id, { v: 1, actions: {} }, context, undefined, undefined, input),
    });
    const input = { machineId: 'machine', rootPath: '/repo', path: 'a.ts', files: [{ path: 'a.ts', expectedHash: 'a'.repeat(64), edits: [] }] };
    expect(await executor.execute('code.rename.apply', input, { surface: 'agent', authority: 'account_automation',
      actionRequestId: 'rename-request', serverId: 'home', runtimeAccountId: 'account', externalActionTarget: { kind: 'machine', machineId: 'machine' },
    })).toMatchObject({ ok: false, errorCode: 'approval_rejected' });
    expect(requests).toMatchObject([{ actionId: 'code.rename.apply', actionArgs: input }]);
    expect(applied).toBe(false);
  });
  it('exposes semantic previews safely and routes reviewed edits through the mutation Action dependency', async () => {
    const preview = ActionIdSchema.parse('code.rename.preview');
    const apply = ActionIdSchema.parse('code.rename.apply');
    const files = [{ path: 'a.ts', expectedHash: 'a'.repeat(64), edits: [{
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, text: 'next',
    }] }];
    const requests: unknown[] = [];
    const executor = createActionExecutor({
      languageIntelligenceQuery: async (args: unknown) => { requests.push(args); return { status: 'ok', kind: 'rename', fileHash: 'a'.repeat(64), files }; },
      languageIntelligenceApply: async (args: unknown) => { requests.push(args); return { ok: true, results: [{ path: 'a.ts', status: 'replaced', hash: 'b'.repeat(64), edits: [] }] }; },
    } as unknown as ActionExecutorDeps);
    expect(await executor.execute(preview, { machineId: 'machine', rootPath: '/repo', path: 'a.ts', line: 1, symbol: 'old', newName: 'next' }, { surface: 'agent' }))
      .toMatchObject({ ok: true, result: { status: 'ok', files } });
    expect(await executor.execute(apply, { machineId: 'machine', rootPath: '/repo', path: 'a.ts', files }, { surface: 'ui', authority: 'present_user' }))
      .toMatchObject({ ok: true, result: { results: [{ status: 'replaced' }] } });
    expect(requests).toMatchObject([
      { request: { kind: 'rename', position: { line: 0, symbol: 'old' }, text: 'disk', newName: 'next' } },
      { actionId: apply, request: { operation: { kind: 'rename', files } } },
    ]);
    for (const id of ['code.rename.apply', 'code.file.rename.apply', 'code.codeAction.apply'] as const) {
      expect(isApprovalRequiredByActionsSettings(id, { v: 1, actions: {} }, { surface: 'agent' })).toBe(true);
      expect(isApprovalRequiredByActionsSettings(id, { v: 1, actions: {} }, { surface: 'ui', authority: 'present_user' })).toBe(false);
    }
  });
  it('queries disk text by one-based line and preserves typed semantic outcomes', async () => {
    const id = ActionIdSchema.parse('code.hover.get');
    const requests: unknown[] = [];
    const fileHash = 'a'.repeat(64);
    let response: unknown = { status: 'ok', kind: 'hover', fileHash,
      sections: [{ serverId: 'test.language', label: 'Language', markdown: 'type Name' }] };
    const executor = createActionExecutor({ languageIntelligenceQuery: async (args: unknown) => {
      requests.push(args); return response;
    } } as unknown as ActionExecutorDeps);
    const input = { machineId: 'machine', rootPath: '/repo', path: 'a.ts', line: 4, symbol: 'Name', occurrence: 2 };
    expect(await executor.execute(id, input, { surface: 'agent' })).toMatchObject({ ok: true, result: { status: 'ok', fileHash } });
    expect(requests).toEqual([{ machineId: 'machine', request: { rootPath: '/repo', path: 'a.ts', kind: 'hover',
      position: { line: 3, symbol: 'Name', occurrence: 2 }, text: 'disk' } }]);
    for (const outcome of [{ status: 'loading' }, { status: 'unavailable', reason: 'server_missing' },
      { status: 'error', errorCode: 'unsaved_editor_changes', diskHash: fileHash },
      { status: 'error', errorCode: 'symbol_not_found', candidates: ['Other'] }]) {
      response = outcome;
      expect(await executor.execute(id, input, { surface: 'mcp' })).toEqual({ ok: true, result: outcome });
    }
  });

  it('searches declarations through the real executor and strict workspace search contract', async () => {
    const id = ActionIdSchema.parse('code.definition.get');
    const requests: unknown[] = [];
    // The remote Machine search is the system boundary; Action admission and query projection are real.
    const executor = createActionExecutor({ languageIntelligenceQuery: async () => ({ status: 'unavailable', reason: 'no_capable_server' }), workspaceFilesSearch: async ({ machineId, ...request }) => {
      expect(machineId).toBe('machine');
      requests.push(DaemonWorkspaceFileSearchRequestSchema.parse(request));
      const candidates = ['other/far.ts', 'src/near.ts', 'src/current.ts'].map(path => ({ path, matches: [
        { line: 4, column16: 8, length16: 14, text: 'export function greet() {}', before: [], after: [] },
      ] }));
      return DaemonWorkspaceFileSearchResponseSchema.parse({ ok: true, files: candidates, hasMore: true, coverage: 'partial' });
    } } satisfies Pick<ActionExecutorDeps, 'workspaceFilesSearch' | 'languageIntelligenceQuery'> as unknown as ActionExecutorDeps);
    const result = await executor.execute(id, { machineId: 'machine', rootPath: '/repo', path: 'src/current.ts', line: 8,
      symbol: 'greet', languageId: 'typescript' }, { surface: 'agent' });
    expect(result).toMatchObject({ ok: true, result: { status: 'ok', source: 'text_matches', hasMore: true, coverage: 'partial',
      locations: [ { path: 'src/current.ts', range: { start: { line: 3, character: 16 }, end: { line: 3, character: 21 } } },
        { path: 'src/near.ts' }, { path: 'other/far.ts' } ] } });
    expect(requests).toMatchObject([{ rootPath: '/repo', regex: true, matchCase: true, query: expect.stringContaining('greet') }]);
    if (!result.ok) throw new Error('Action failed');
    expect(getActionSpec(id).outputSchema!.parse(result.result)).toEqual(result.result);
  });

  it('preserves unavailable search and rejects a missing symbol instead of guessing a column', async () => {
    const id = ActionIdSchema.parse('code.references.list');
    const executor = createActionExecutor({ languageIntelligenceQuery: async () => ({ status: 'unavailable', reason: 'no_capable_server' }), workspaceFilesSearch: async () => ({ ok: false, code: 'root_not_found' }) } as unknown as ActionExecutorDeps);
    const input = { machineId: 'machine', rootPath: '/repo', path: 'a.ts', line: 1, symbol: 'name' };
    await expect(executor.execute(id, input, { surface: 'mcp' })).resolves.toMatchObject({ ok: true,
      result: { status: 'unavailable', reason: 'root_not_found' } });
    expect(getActionSpec(id).inputSchema.safeParse({ ...input, symbol: undefined, character: 0 }).success).toBe(true);
    expect(await executor.execute(id, { ...input, symbol: undefined }, { surface: 'agent' }))
      .toEqual({ ok: true, result: { status: 'error', errorCode: 'invalid_position' } });
    expect(await executor.execute(id, { ...input, symbol: undefined, character: 0 }, { surface: 'agent' }))
      .toEqual({ ok: true, result: { status: 'unavailable', reason: 'no_capable_server' } });
  });

  it('keeps both safe reads available to plugins and honors explicit approval settings', () => {
    for (const rawId of ['code.hover.get', 'code.definition.get', 'code.references.list', 'code.symbols.list', 'code.diagnostics.list', 'code.restart']) {
      const id = ActionIdSchema.parse(rawId);
      const spec = getActionSpec(id);
      expect(spec).toMatchObject({ sideEffectClass: id === 'code.restart' ? 'write' : 'read', safety: 'safe', approval: { result: 'required' }, executionPlacement: 'machine' });
      expect(isPluginSurfaceExcludedActionId(id)).toBe(false);
      expect(spec.pluginCallerPolicy).toBeUndefined();
      for (const surface of ['ui', 'agent', 'mcp', 'cli', 'plugin'] as const) {
        expect(isApprovalRequiredByActionsSettings(id, { v: 1, actions: {} }, { surface })).toBe(false);
      }
      expect(isApprovalRequiredByActionsSettings(id, { v: 1, actions: { [id]: { approvalRequiredSurfaces: ['agent'] } } }, { surface: 'agent' })).toBe(true);
    }
  });

  it('keeps the language-server selector distinct from the Home and validates semantic hashes', async () => {
    const requests: unknown[] = [];
    const executor = createActionExecutor({
      languageIntelligenceRestart: async (args: unknown, context: unknown) => { requests.push({ args, context }); return { status: 'ok' }; },
      languageIntelligenceQuery: async () => ({ status: 'ok', kind: 'hover', sections: [] }),
    } as unknown as ActionExecutorDeps);
    expect(await executor.execute('code.restart', { machineId: 'machine', rootPath: '/repo', serverId: 'language.definition' },
      { surface: 'ui', authority: 'present_user', serverId: 'home' })).toEqual({ ok: true, result: { status: 'ok' } });
    expect(requests).toMatchObject([{ args: { machineId: 'machine', request: { rootPath: '/repo', serverId: 'language.definition' } }, context: { serverId: 'home' } }]);
    expect(await executor.execute('code.hover.get', { machineId: 'machine', rootPath: '/repo', path: 'a.ts', line: 1, character: 0 },
      { surface: 'agent' })).toMatchObject({ ok: false, errorCode: 'invalid_response' });
  });
});
