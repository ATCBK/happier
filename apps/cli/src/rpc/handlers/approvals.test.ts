import { describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerApprovalRpcHandlers } from './approvals';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcActionExecutor } from './_actionDispatchAdapter';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { resolveSessionRpcContent } from '@/session/transport/rpc/sessionRpc';
import type { RpcHandlerContext } from '@/api/rpc/types';

describe('approval RPC handlers', () => {
  it('keeps a verified requester decision on the original executor even when requester Account custody is attached', async () => {
    const handlers = new Map<string, (input: unknown, context?: RpcHandlerContext) => Promise<unknown>>();
    const original = vi.fn<RpcActionExecutor['execute']>(async () => ({ ok: true, result: { account: 'alice' } }));
    const requester = vi.fn<RpcActionExecutor['execute']>(async () => ({ ok: true, result: { account: 'bob' } }));
    registerApprovalRpcHandlers({ rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } },
      actionExecutor: { execute: original } });
    const decide = handlers.get(RPC_METHODS.APPROVAL_REQUEST_DECIDE);
    if (!decide) throw new Error('missing decision handler');
    expect(await decide({ artifactId: 'request', decision: 'approved', sessionId: 'bot-session' }, {
      signal: new AbortController().signal, callerAuthority: 'present_user',
      requesterApprovalDecision: { sessionId: 'bot-session',
        actor: { kind: 'accountUser', accountId: 'bob', relationship: 'sharedApprover' }, isCurrent: async () => true },
      callerInputAuthorization: { v: 1, token: 'admitted-root', binding: {
        accountId: 'bob', custodianAccountId: 'alice', authentication: { kind: 'account', tokenEpoch: 1 },
        accountEncryptionMode: 'plain', serverIdentityId: 'home', machineId: 'bot-machine', installationId: 'installation',
        actionId: 'approval.request.decide', requestId: 'original-request', requestEnvelopeDigest: 'a'.repeat(43),
        target: { kind: 'machine', machineId: 'bot-machine' },
      }, requesterAccountExecutor: { execute: requester } },
    })).toEqual({ account: 'alice' });
    expect(requester).not.toHaveBeenCalled();
  });
  it('preserves ordinary owner decisions on the existing Machine handler without minting requester authority', async () => {
    const rpc = new RpcHandlerManager({ scopePrefix: 'bot-machine', encryptionMode: 'plain', logger: () => {} });
    const execute = vi.fn<RpcActionExecutor['execute']>(async (_actionId, _input, context) => ({ ok: true,
      result: { authority: context?.authority, requesterDecision: context?.requesterApprovalDecision ?? null } }));
    registerApprovalRpcHandlers({ rpcHandlerManager: rpc, actionExecutor: { execute } });
    expect(await rpc.handleRequest({ method: 'bot-machine:approval.request.decide', callerAuthority: 'present_user',
      params: { artifactId: 'request', decision: 'approved' } }))
      .toEqual({ authority: 'present_user', requesterDecision: null });
  });
  it('binds a requester decision to its authenticated Session actor and rechecks current access after forwarding', async () => {
    let current = true;
    const rpc = new RpcHandlerManager({ scopePrefix: 'bot-machine', encryptionMode: 'plain', logger: () => {},
      resolveSessionDecisionContext: async () => ({ content: { mode: 'plain' }, isCurrent: async () => current }),
    });
    const execute = vi.fn<RpcActionExecutor['execute']>(async (_actionId, _input, context) => {
      if (!context?.requesterApprovalDecision) throw new Error('missing requester decision');
      expect(context.requesterApprovalDecision.actor.accountId).toBe('bob');
      expect(context.requesterApprovalDecision.sessionId).toBe('bot-session');
      expect(await context.requesterApprovalDecision.isCurrent()).toBe(true);
      current = false;
      return { ok: true as const, result: { effectAllowed: await context.requesterApprovalDecision.isCurrent() } };
    });
    registerApprovalRpcHandlers({ rpcHandlerManager: rpc, actionExecutor: { execute } });
    const request = { method: 'bot-session:approval.request.decide',
      params: { artifactId: 'request', decision: 'approved', sessionId: 'bot-session' },
      callerAuthority: 'present_user' as const,
      authorization: { kind: 'session.permission.respond' as const, sessionId: 'bot-session',
        authentication: { tokenEpoch: 1 },
        actor: { kind: 'accountUser' as const, accountId: 'bob', relationship: 'sharedApprover' as const } },
    };
    expect(await rpc.handleRequest(request)).toEqual({ effectAllowed: false });
    expect(await rpc.handleRequest(request)).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each(['account_automation', 'missing_actor', 'missing_authentication', 'wrong_session', 'no_verifier'])(
    'does not supply requester decision authority for %s', async scenario => {
      const rpc = new RpcHandlerManager({ scopePrefix: 'bot-machine', encryptionMode: 'plain', logger: () => {},
        ...(scenario === 'no_verifier' ? {} : { resolveSessionDecisionContext: async () => ({ content: { mode: 'plain' as const }, isCurrent: async () => true }) }),
      });
      const execute = vi.fn(async () => ({ ok: true as const, result: {} }));
      registerApprovalRpcHandlers({ rpcHandlerManager: rpc, actionExecutor: { execute } });
      const result = await rpc.handleRequest({ method: 'bot-session:approval.request.decide',
        params: { artifactId: 'request', decision: 'approved', sessionId: 'bot-session' },
        callerAuthority: scenario === 'account_automation' ? 'account_automation' : 'present_user',
        ...(scenario === 'missing_actor' ? {} : { authorization: {
          kind: 'session.permission.respond' as const, sessionId: scenario === 'wrong_session' ? 'other' : 'bot-session',
          ...(scenario === 'missing_authentication' ? {} : { authentication: { tokenEpoch: 1 } }),
          actor: { kind: 'accountUser' as const, accountId: 'bob', relationship: 'sharedApprover' as const },
        } }),
      });
      expect(result).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it('retains the exact Session cipher and wire binding while dispatching the existing Machine handler', async () => {
    const content = resolveSessionRpcContent({ mode: 'e2ee', ctx: {
      encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'dataKey',
    } });
    const rpc = new RpcHandlerManager({ scopePrefix: 'bot-machine', encryptionMode: 'e2ee',
      encryptionKey: new Uint8Array(32).fill(9), encryptionVariant: 'dataKey', logger: () => {},
      resolveSessionDecisionContext: async () => ({ content, isCurrent: async () => true }),
    });
    const execute = vi.fn<RpcActionExecutor['execute']>(async (_actionId, input, context) => ({ ok: true,
      result: { input, actor: context?.requesterApprovalDecision?.actor.accountId } }));
    registerApprovalRpcHandlers({ rpcHandlerManager: rpc, actionExecutor: { execute } });
    const binding = { method: 'bot-session:approval.request.decide', callId: '0123456789abcdef0123456789abcdef' };
    const input = { artifactId: 'request', decision: 'approved', sessionId: 'bot-session' };
    const authorization = { kind: 'session.permission.respond' as const, sessionId: 'bot-session',
      authentication: { tokenEpoch: 1 },
      actor: { kind: 'accountUser' as const, accountId: 'bob', relationship: 'sharedApprover' as const } };
    const response = await rpc.handleRequest({ method: binding.method,
      params: await socketRpcCodec.encodeParams(content, input, binding), callerAuthority: 'present_user', authorization });
    expect(await socketRpcCodec.decodeResult(content, { ok: true, result: response }, binding.callId))
      .toEqual({ input, actor: 'bob' });
    const wrongInput = { ...input, sessionId: 'other' };
    const refused = await rpc.handleRequest({ method: binding.method,
      params: await socketRpcCodec.encodeParams(content, wrongInput, binding), callerAuthority: 'present_user', authorization });
    await expect(socketRpcCodec.decodeResult(content, { ok: true, result: refused }, binding.callId))
      .resolves.toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
    expect(execute).toHaveBeenCalledTimes(1);
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
