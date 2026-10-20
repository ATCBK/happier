import { describe, expect, it } from 'vitest';

import { readApprovalExecutionFailure } from './approvalExecutionFailure.js';
import { ApprovalRequestSchema } from './approvalRequestV1.js';

describe('persisted filesystem approval effects', () => {
  it('projects a strict failed write result as one typed approval failure', () => {
    const request = ApprovalRequestSchema.parse({
      v: 1,
      status: 'executed',
      createdAtMs: 1,
      updatedAtMs: 3,
      createdBy: { surface: 'agent', sessionId: 'session-1' },
      requestedSurface: 'agent',
      actionId: 'daemon.filesystem.writeFile',
      actionArgs: { root: '/workspace', path: '.', content: '' },
      summary: 'Write file',
      decision: { kind: 'approve', decidedAtMs: 2 },
      execution: {
        executedAtMs: 3,
        ok: true,
        result: { success: false, error: 'EISDIR: illegal operation on a directory' },
      },
    });

    expect(readApprovalExecutionFailure(request)).toEqual({
      ok: false,
      errorCode: 'filesystem_operation_failed',
      error: 'EISDIR: illegal operation on a directory',
    });
  });
});
