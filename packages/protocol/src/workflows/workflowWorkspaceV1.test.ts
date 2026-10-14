import { describe, expect, it } from 'vitest';

import { WorkflowCommittedRevisionV1Schema, WorkflowWorkspaceProgressV1Schema, WorkflowWorkspaceResolutionV1Schema } from './workflowWorkspaceV1.js';

describe('workflow workspace v1', () => {
  it('persists exact creation intent separately from the realized descriptor', () => {
    const creationIntent = {
      kind: 'git_worktree', sourceDirectory: '/repo/packages/app', baseRef: 'a'.repeat(40),
      displayName: 'workflow-run-1-inv-a', branchMode: 'new',
    };
    expect(WorkflowWorkspaceProgressV1Schema.parse({ creationIntent })).toEqual({ creationIntent });
    expect(WorkflowWorkspaceProgressV1Schema.safeParse({}).success).toBe(false);
    // An explicit SCM ref is authored intent, not the immutable revision captured at admission.
    expect(WorkflowWorkspaceProgressV1Schema.parse({ creationIntent: { ...creationIntent, baseRef: 'main' } }))
      .toEqual({ creationIntent: { ...creationIntent, baseRef: 'main' } });
    expect(WorkflowCommittedRevisionV1Schema.safeParse('main').success).toBe(false);
    expect(WorkflowWorkspaceProgressV1Schema.safeParse({ creationIntent: { ...creationIntent, baseRef: ' ' } }).success).toBe(false);
    expect(WorkflowWorkspaceProgressV1Schema.safeParse({ creationIntent: { ...creationIntent, machineId: 'foreign' } }).success).toBe(false);
  });

  it('keeps runtime workspace outcomes closed and typed', () => {
    const unavailable = { ok: false, code: 'workspace_unavailable' } as const;
    expect(WorkflowWorkspaceResolutionV1Schema.parse(unavailable)).toEqual(unavailable);
    expect(WorkflowWorkspaceResolutionV1Schema.safeParse({ ...unavailable, path: '/other' }).success).toBe(false);
  });
});
