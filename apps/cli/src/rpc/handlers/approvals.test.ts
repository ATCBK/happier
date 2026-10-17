import { describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerApprovalRpcHandlers } from './approvals';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcHandlerContext } from '@/api/rpc/types';

describe('approval RPC handlers', () => {
  it('keeps exact approved replay on the daemon executor when requester projection is attached', async () => {
    const handlers = new Map<string, (input: unknown, context?: RpcHandlerContext) => Promise<unknown>>();
    const daemonReplay = vi.fn(async () => ({ ok: true, result: { status: 'executed' } }));
    const requesterReplay = vi.fn(async () => ({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' }));
    registerApprovalRpcHandlers({
      rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } },
      actionExecutor: { execute: async () => ({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' }),
        replayApprovedApprovalRequest: daemonReplay },
    });
    const replay = handlers.get(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED);
    if (!replay) throw new Error('Missing approved replay handler');

    await expect(replay({ artifactId: 'approved-write' }, { callerAuthority: 'present_user',
      callerInputAuthorization: { requesterAccountExecutor: {
        execute: async () => ({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' }),
        replayApprovedApprovalRequest: requesterReplay,
      } } })).resolves.toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(daemonReplay).toHaveBeenCalledWith({ artifactId: 'approved-write', callerAuthority: 'present_user' });
    expect(requesterReplay).not.toHaveBeenCalled();
  });

  it('does not admit payload-labelled human authority through the private continuation handler', async () => {
    const rpc = new RpcHandlerManager({ scopePrefix: 'machine-1', encryptionMode: 'plain', logger: () => {} });
    registerApprovalRpcHandlers({ rpcHandlerManager: rpc });
    const response = await rpc.handleRequest({
      method: `machine-1:${RPC_METHODS.APPROVAL_REQUEST_SECRET_CONTINUE}`,
      params: { authority: 'present_user', choice: { kind: 'once', value: 'private-test-value' } },
      callerAuthority: 'account_automation',
    });
    expect(response).toEqual({ status: 'refused', code: 'approval_required' });
    expect(JSON.stringify(response)).not.toContain('private-test-value');
  });
});
