import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerApprovalRpcHandlers } from './approvals';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';

describe('approval RPC handlers', () => {
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
