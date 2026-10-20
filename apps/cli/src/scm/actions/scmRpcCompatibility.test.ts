import { describe, expect, it } from 'vitest';
import { z } from 'zod/mini';
import { projectScmLegacyRpcResponse } from './scmRpcCompatibility';

// Reader fields observed in ../0.2 packages/protocol/src/scmWorktrees.ts,
// HEAD 17ba05df68d4d3d4cad1c1241b58e63805db37ed, clean path at inspection.
const predecessorWorktreeReader = z.object({
  success: z.boolean(), worktreePath: z.string(), branchName: z.string(),
});

describe('SCM predecessor RPC projection', () => {
  it('preserves canonical nested evidence while translating only legacy outer fields', () => {
    const response = {
      success: false, errorCode: 'COMMIT_SIGNING_FAILED', operationState: { kind: 'revert' },
      outcome: { v: 1, kind: 'failed', errorCode: 'COMMIT_SIGNING_FAILED', nextActions: [], repositoryState: { hasConflicts: true, operation: { kind: 'revert' } } },
    };
    expect(projectScmLegacyRpcResponse({ actionId: 'scm.branch.operation.continue', request: {}, response })).toEqual({
      ...response, errorCode: 'COMMAND_FAILED', operationState: null,
    });
    expect(projectScmLegacyRpcResponse({ actionId: 'scm.branch.operation.continue', request: { outcomeVersion: 1 }, response })).toEqual(response);
  });

  it('keeps failure identities absent canonically but supplies the predecessor-required empty fields only on legacy worktree creation', () => {
    const response = { success: false, errorCode: 'NOT_REPOSITORY', outcome: { v: 1, kind: 'failed', errorCode: 'NOT_REPOSITORY', nextActions: [] } };
    const args = { actionId: 'scm.worktree.create', response };
    expect(predecessorWorktreeReader.safeParse(response).success).toBe(false);
    const legacy = projectScmLegacyRpcResponse({ ...args, request: {} });
    expect(predecessorWorktreeReader.parse(legacy)).toEqual({ success: false, worktreePath: '', branchName: '' });
    expect(legacy).toMatchObject({ outcome: response.outcome });
    expect(projectScmLegacyRpcResponse({ ...args, request: { outcomeVersion: 1 } })).toEqual(response);
    expect(projectScmLegacyRpcResponse({ actionId: 'scm.branch.create', request: {}, response })).toEqual(response);
    const success = { success: true, worktreePath: '/existing', branchName: 'feature' };
    expect(projectScmLegacyRpcResponse({ ...args, request: {}, response: success })).toEqual(success);
  });
});
