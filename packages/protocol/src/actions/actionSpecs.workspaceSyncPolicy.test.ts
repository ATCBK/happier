import { describe, expect, it } from 'vitest';

import { WorkspaceContentPolicyV1Schema } from '../sessions/control/handoff/workspaceSyncSchemas.js';
import { createActionExecutor } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import type { ActionExecutorDeps } from './executor/types.js';

describe('workspace sync relationship policy discovery', () => {
  it('gives Agent and UI callers complete digest-bearing policy choices', async () => {
    const field = getActionSpec('workspace.sync.relationship.create').inputHints?.fields
      .find((candidate) => candidate.path === 'contentPolicy');
    expect(field).toMatchObject({ widget: 'select', required: true });
    expect(field?.options).toHaveLength(2);
    for (const option of field?.options ?? []) {
      expect(WorkspaceContentPolicyV1Schema.safeParse(option.value).success).toBe(true);
    }

    const executor = createActionExecutor({} as ActionExecutorDeps);
    await expect(executor.execute('action.options.resolve', {
      actionId: 'workspace.sync.relationship.create', fieldPath: 'contentPolicy',
    }, { surface: 'agent', authority: 'account_automation' })).resolves.toMatchObject({
      ok: true,
      result: {
        actionId: 'workspace.sync.relationship.create',
        fieldPath: 'contentPolicy',
        options: expect.arrayContaining([
          expect.objectContaining({ value: expect.objectContaining({ selection: 'git_worktree', policyDigest: expect.any(String) }) }),
          expect.objectContaining({ value: expect.objectContaining({ selection: 'all_files', policyDigest: expect.any(String) }) }),
        ]),
      },
    });
  });
});
