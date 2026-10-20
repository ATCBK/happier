import { describe, expect, it } from 'vitest';

import { getActionSpec } from './actionSpecs.js';
import { isHomeDomainActionIdV1, readHomeDomainActionErrorV1 } from './homeDomainActionFamily.js';
import { bindHomeDomainHttpRequestV1 } from './homeDomainHttpBinding.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { encodeV2SessionListCursorV2 } from '../sessions/listing/cursor.js';

const context = { surface: 'agent', authority: 'account_automation', defaultSessionId: 'lead' } as const;

describe('session.manager.set contract', () => {
  it('executes in-subtree reparenting through the Session relation port after server-proved paginated membership', async () => {
    let page = 0;
    // Replace authenticated Session HTTP ports only; subtree proof, admission and result validation stay real.
    const executor = createActionExecutor({
      sessionList: async () => ({
        sessions: page++ === 0
          ? [{ id: 'worker', active: false, presence: 'offline', updatedAt: 10 }]
          : [{ id: 'sublead', active: false, presence: 'offline', updatedAt: 10 }],
        nextCursor: page === 1 ? encodeV2SessionListCursorV2({ sessionId: 'worker', meaningfulActivityAt: 10 }) : null, hasNext: page === 1,
        queryVersion: 1, attentionNextCursor: null, attentionHasNext: false,
      }),
      sessionManagerSet: async () => ({ ok: true, sessionId: 'worker', managerSessionId: 'sublead', attachedAt: 10 }),
    } as unknown as ActionExecutorDeps);
    await expect(executor.execute('session.manager.set', {
      sessionId: 'worker', managerSessionId: 'sublead', expectedManagerSessionId: 'lead',
    }, context)).resolves.toEqual({ ok: true, result: { ok: true, sessionId: 'worker', managerSessionId: 'sublead', attachedAt: 10 } });
  });

  it.each([
    ['outside child', 'outside', 'lead'],
    ['outside lead', 'worker', 'outside'],
  ] as const)('does not waive danger confirmation for an %s or an unproved subtree result', async (_label, sessionId, managerSessionId) => {
    for (const marked of [true, false]) {
      let mutated = false;
      // Replace authenticated Session HTTP ports only; the real executor must refuse before mutation.
      const executor = createActionExecutor({
        sessionList: async () => ({ sessions: [], nextCursor: null, hasNext: false,
          ...(marked ? { queryVersion: 1, attentionNextCursor: null, attentionHasNext: false } : {}),
        }),
        sessionManagerSet: async () => { mutated = true; return { ok: true, sessionId, managerSessionId, attachedAt: 10 }; },
      } as unknown as ActionExecutorDeps);
      const result = await executor.execute('session.manager.set', {
        sessionId, managerSessionId, expectedManagerSessionId: null,
      }, context);
      expect(result).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
      expect(mutated).toBe(false);
    }
  });
  it('carries a strict CAS mutation through the declared Session relation transport', () => {
    expect(isHomeDomainActionIdV1('session.manager.set')).toBe(false);
    const spec = getActionSpec('session.manager.set');
    const input = { sessionId: 'worker/1', managerSessionId: 'lead', expectedManagerSessionId: null };
    expect(spec.inputSchema.parse(input)).toEqual(input);
    expect(spec.inputSchema.safeParse({ ...input, expectedManagerSessionId: undefined }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, accountId: 'fabricated' }).success).toBe(false);
    expect(bindHomeDomainHttpRequestV1({ transport: spec.serverTransport!, inputSchema: spec.inputSchema, input })).toEqual({
      method: 'POST', path: '/v1/sessions/worker%2F1/manager',
      body: { managerSessionId: 'lead', expectedManagerSessionId: null },
    });
    expect(spec.surfaces).toMatchObject({ ui: true, cli: true, voice: true, agent: true, mcp: true });
    expect(spec.outputSchema.safeParse({ ok: true, sessionId: 'worker', managerSessionId: 'lead', attachedAt: 1 }).success).toBe(true);
    expect(spec.outputSchema.safeParse({ ok: true, sessionId: 'worker', managerSessionId: null, attachedAt: null }).success).toBe(true);
    expect(spec.outputSchema.safeParse({ ok: true, sessionId: 'worker', managerSessionId: 'lead', attachedAt: -1 }).success).toBe(false);
    expect(spec.outputSchema.safeParse({ ok: true, sessionId: 'worker', managerSessionId: 'lead', attachedAt: null }).success).toBe(false);
    expect(spec.outputSchema.safeParse({ ok: true, sessionId: 'worker', managerSessionId: 'lead', attachedAt: 1, accountId: 'fabricated' }).success).toBe(false);
  });

  it('preserves closed graph refusals through the schema and Session relation port', async () => {
    const resultSchema = getActionSpec('session.manager.set').outputSchema;
    for (const error of ['manager_cycle', 'manager_cas_conflict'] as const) {
      const executor = createActionExecutor({ sessionManagerSet: async () => ({ ok: false, error }) } as unknown as ActionExecutorDeps);
      expect(await executor.execute('session.manager.set', {
        sessionId: 'worker', managerSessionId: 'lead', expectedManagerSessionId: null,
      }, { surface: 'ui', authority: 'present_user', bypassApprovals: true })).toMatchObject({ ok: false, errorCode: error });
      expect(resultSchema.parse({ ok: false, error })).toEqual({ ok: false, error });
      expect(readHomeDomainActionErrorV1({ ok: false, error })).toBeNull();
    }
    expect(resultSchema.parse({ ok: false, error: 'manager_forbidden', reason: 'pairwise' })).toEqual({ ok: false, error: 'manager_forbidden', reason: 'pairwise' });
    expect(resultSchema.safeParse({ ok: false, error: 'manager_forbidden', reason: 'owner' }).success).toBe(false);
    expect(resultSchema.safeParse({ ok: false, error: 'manager_cycle', revision: 1 }).success).toBe(false);
  });
});
