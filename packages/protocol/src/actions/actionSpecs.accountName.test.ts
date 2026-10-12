import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { bindHomeDomainActionHttpRequestV1, HomeDomainActionIdV1Schema } from './homeDomainActionFamily.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

describe('self Account profile Actions', () => {
  it('reads only the caller’s safe profile through the existing route and drops unrelated profile material', async () => {
    const actionId = ActionIdSchema.parse('account.profile.get');
    const spec = getActionSpec(actionId);
    expect(spec).toMatchObject({ safety: 'safe', sideEffectClass: 'read', executionPlacement: 'account', requiredAuthority: 'account_automation' });
    expect(spec.approval).toMatchObject({ result: 'required' });
    expect(spec.inputSchema.safeParse({ accountId: 'another-account' }).success).toBe(false);
    expect(bindHomeDomainActionHttpRequestV1(HomeDomainActionIdV1Schema.parse(actionId), {})).toEqual({ method: 'GET', path: '/v1/account/profile' });
    const profile = { id: 'self', timestamp: 1, firstName: 'Legacy', lastName: 'Name', username: 'self', avatar: null,
      connectedServices: ['unrelated'], privateFutureField: 'never disclose' };
    // Only the answering HTTP service is substituted; the Action parser and settlement stay real.
    const executor = createActionExecutor({ homeDomainAction: async () => profile } as unknown as ActionExecutorDeps);
    expect(await executor.execute(actionId, {}, { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' } }))
      .toEqual({ ok: true, result: { id: 'self', timestamp: 1, name: 'Legacy Name', firstName: 'Legacy', lastName: 'Name', username: 'self', avatar: null } });
  });

  it.each([
    ['account.name.set', '/v1/account/profile', { name: 'Leeroy Brun' }],
    ['account.username.set', '/v1/account/username', { username: 'leeroybrun' }],
  ])('admits %s only for the caller through its canonical route and result-bearing approval', (id, path, input) => {
    const actionId = ActionIdSchema.parse(id);
    const spec = getActionSpec(actionId);
    expect(spec.surfaces.agent).toBe(true);
    expect(spec.safety).toBe('danger');
    expect(spec.sideEffectClass).toBe('write');
    expect(spec.approval).toMatchObject({ result: 'required' });
    expect(spec.inputSchema.safeParse({ ...input, accountId: 'other' }).success).toBe(false);
    expect(bindHomeDomainActionHttpRequestV1(HomeDomainActionIdV1Schema.parse(id), input)).toEqual({ method: 'POST', path, body: input });
  });

  it('executes the name write through the admitted Home transport and returns the acknowledged profile', async () => {
    const result = { name: 'Captain', firstName: 'Captain', lastName: null, timestamp: 1 };
    // This dependency is the host HTTP transport; all catalog and executor logic remains real.
    const executor = createActionExecutor({
      homeDomainAction: async () => result,
      isActionApprovalRequired: () => false,
      interceptActionExecution: async ({ input }) => ({ status: 'continue', input }),
    } as unknown as ActionExecutorDeps);
    expect(await executor.execute(ActionIdSchema.parse('account.name.set'), { name: 'Captain' }, {
      surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
    })).toEqual({ ok: true, result });
  });
});
