import { describe, expect, it } from 'vitest';
import { ExecutionRunStartRequestSchema, ExecutionRunDetachedStartRequestV1Schema } from './startRequest.js';

describe('execution Run tool policy admission', () => {
  const request = {
    intent: 'agent', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, instructions: 'Prepare a brief.',
    permissionMode: 'read-only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'request_response',
  };

  it.each([
    { schema: ExecutionRunStartRequestSchema, input: request },
    { schema: ExecutionRunDetachedStartRequestV1Schema, input: {
      intent: 'task', backendTarget: request.backendTarget, permissionMode: 'read_only',
      retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
    } },
  ])('validates the exclusive policy instead of preserving malformed unknown inputs', ({ schema, input }) => {
    expect(schema.safeParse({ ...input, allowedTools: ['mcp__wilson-brief__*'], unlistedTools: 'deny' }))
      .toMatchObject({ success: true, data: { allowedTools: ['mcp__wilson-brief__*'], unlistedTools: 'deny' } });
    expect(schema.safeParse({ ...input, allowedTools: ['mcp__wilson-brief__*', 1], unlistedTools: 'deny' }).success).toBe(false);
    expect(schema.safeParse({ ...input, unlistedTools: 'approve' }).success).toBe(false);
    expect(schema.safeParse(input).success).toBe(true);
  });
});
