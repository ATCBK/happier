import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { isAgentInitiatedApprovalRequiredByDefault } from './actionApprovalPolicy.js';

describe('workspace replace public Action contract', () => {
  it('exposes guarded replace and restore through the same dangerous Action', () => {
    expect(ActionIdSchema.safeParse('workspace.files.replace.preview').success).toBe(true);
    expect(ActionIdSchema.safeParse('workspace.files.replace').success).toBe(true);
    const preview = getActionSpec(ActionIdSchema.parse('workspace.files.replace.preview'));
    const apply = getActionSpec(ActionIdSchema.parse('workspace.files.replace'));
    expect(preview).toMatchObject({ safety: 'safe', sideEffectClass: 'read' });
    expect(apply).toMatchObject({ safety: 'danger', sideEffectClass: 'danger', approvalPolicy: { uiConfirmation: 'direct' },
      surfaces: { rpc: true }, bindings: { rpcMethod: 'daemon.workspaceFiles.replace.apply.v1' } });
    expect(isAgentInitiatedApprovalRequiredByDefault(apply.id)).toBe(true);
    expect(isAgentInitiatedApprovalRequiredByDefault(preview.id)).toBe(false);
    const input = { machineId: 'machine', rootPath: '/repo', operation: { kind: 'replace', matcher: { query: 'old', replacement: 'new' }, files: [{ path: 'a.txt', expectedHash: 'a'.repeat(64) }] } };
    expect(apply.inputSchema.safeParse(input).success).toBe(true);
    expect(apply.inputSchema.safeParse({ machineId: 'machine', rootPath: '/repo', operation: { kind: 'restore', files: [{
      path: 'a.txt', expectedHash: 'a'.repeat(64), edits: [{ startUtf16: 0, deleteLength: 3, insertText: 'new', originalText: 'old' }],
    }] } }).success).toBe(true);
    expect(apply.inputSchema.safeParse({ machineId: 'machine', rootPath: '/repo', operation: {
      kind: 'editSet', files: [],
    } }).success).toBe(false);
    expect(apply.inputSchema.safeParse({ ...input, operation: { ...input.operation, matcher: { query: 'old', replacement: 'new\nline' } } }).success).toBe(false);
  });
});
