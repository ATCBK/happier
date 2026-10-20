import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { isPluginSurfaceExcludedActionId } from './pluginActionSurface.js';
import { DaemonWorkspaceFileSearchRequestSchema, DaemonWorkspaceFileSearchResponseSchema } from '../machines/workspaceFiles.js';

describe('search-backed code Actions', () => {
  it('searches declarations through the real executor and strict workspace search contract', async () => {
    const id = ActionIdSchema.parse('code.definition.get');
    const requests: unknown[] = [];
    // The remote Machine search is the system boundary; Action admission and query projection are real.
    const executor = createActionExecutor({ workspaceFilesSearch: async ({ machineId, ...request }) => {
      expect(machineId).toBe('machine');
      requests.push(DaemonWorkspaceFileSearchRequestSchema.parse(request));
      const candidates = ['other/far.ts', 'src/near.ts', 'src/current.ts'].map(path => ({ path, matches: [
        { line: 4, column16: 8, length16: 14, text: 'export function greet() {}', before: [], after: [] },
      ] }));
      return DaemonWorkspaceFileSearchResponseSchema.parse({ ok: true, files: candidates, hasMore: true, coverage: 'partial' });
    } } satisfies Pick<ActionExecutorDeps, 'workspaceFilesSearch'> as unknown as ActionExecutorDeps);
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
    const executor = createActionExecutor({ workspaceFilesSearch: async () => ({ ok: false, code: 'root_not_found' }) } as unknown as ActionExecutorDeps);
    const input = { machineId: 'machine', rootPath: '/repo', path: 'a.ts', line: 1, symbol: 'name' };
    await expect(executor.execute(id, input, { surface: 'mcp' })).resolves.toMatchObject({ ok: true,
      result: { status: 'unavailable', reason: 'root_not_found' } });
    expect(getActionSpec(id).inputSchema.safeParse({ ...input, symbol: undefined, character: 0 }).success).toBe(false);
  });

  it('keeps both safe reads available to plugins and honors explicit approval settings', () => {
    for (const rawId of ['code.definition.get', 'code.references.list']) {
      const id = ActionIdSchema.parse(rawId);
      const spec = getActionSpec(id);
      expect(spec).toMatchObject({ sideEffectClass: 'read', safety: 'safe', approval: { result: 'required' }, executionPlacement: 'machine' });
      expect(isPluginSurfaceExcludedActionId(id)).toBe(false);
      expect(spec.pluginCallerPolicy).toBeUndefined();
      for (const surface of ['ui', 'agent', 'mcp', 'cli', 'plugin'] as const) {
        expect(isApprovalRequiredByActionsSettings(id, { v: 1, actions: {} }, { surface })).toBe(false);
      }
      expect(isApprovalRequiredByActionsSettings(id, { v: 1, actions: { [id]: { approvalRequiredSurfaces: ['agent'] } } }, { surface: 'agent' })).toBe(true);
    }
  });
});
