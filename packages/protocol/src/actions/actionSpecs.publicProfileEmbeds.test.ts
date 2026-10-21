import { describe, expect, it, vi } from 'vitest';
import { getActionSpec } from './actionSpecs.js';
import { createActionExecutor } from './actionExecutor.js';
import { bindHomeDomainActionHttpRequestV1 } from './homeDomainActionFamily.js';

describe('public-profile embed Action transport', () => {
  it('reads through the declared captured Account transport and never claims or invokes clipboard delivery', async () => {
    const clipboardWrite = vi.fn();
    const request = { kind: 'badge', metric: 'tokens', theme: 'dark', syntax: 'markdown' } as const;
    const sent: unknown[] = [];
    const executor = createActionExecutor({
      homeDomainAction: async invocation => {
        sent.push(bindHomeDomainActionHttpRequestV1(invocation.actionId, invocation.input));
        return { kind: 'unavailable', reason: 'field_hidden' };
      },
      clipboardWrite,
    });
    const spec = getActionSpec('account.public_profile.embed.get');
    expect(spec.safety).toBe('safe');
    expect(spec.surfaces).toMatchObject({ ui: true, cli: true, agent: true, mcp: false });
    const result = await executor.execute('account.public_profile.embed.get', request, { surface: 'cli', authority: 'account_automation' });
    expect(result).toEqual({ ok: true, result: { kind: 'unavailable', reason: 'field_hidden' } });
    expect(sent).toEqual([{ method: 'GET', path: '/v1/account/public-profile/embed?kind=badge&metric=tokens&theme=dark&syntax=markdown', body: undefined }]);
    expect(clipboardWrite).not.toHaveBeenCalled();
  });
});
