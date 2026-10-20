import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectMiniMaxModelChoices } from '@happier-dev/protocol';
import { resolveClaudeModelCatalogResolution, resetClaudeModelCatalogCacheForTests } from './resolveClaudeModelCatalog';

const ids = ['MiniMax-M2.7', 'MiniMax-M3', 'MiniMax-M3.1-Flash', 'speech-02-hd'];
const credentials = { token: 'test-account', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) } };

afterEach(() => {
  vi.unstubAllGlobals();
  resetClaudeModelCatalogCacheForTests();
});

describe('MiniMax profile discovery at the HTTP boundary', () => {
  it.each([
    ['minimax', 'MINIMAX', 'https://api.minimax.io/anthropic'],
    ['minimax-cn', 'MINIMAX_CN', 'https://api.minimaxi.com/anthropic'],
  ])('keeps full %s membership while carrying current configuration separately from the HTTP cache', async (profileId, prefix, baseUrl) => {
    const transport = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(`${baseUrl}/v1/models?limit=1000`);
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-key');
      return new Response(JSON.stringify({ data: ids.map(id => ({ id, display_name: id })) }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', transport);
    const params = { profileId, credentials, accountSettings: {}, timeoutMs: 1000,
      processEnv: { [`${prefix}_AUTH_TOKEN`]: 'fixture-key' } };
    const result = await resolveClaudeModelCatalogResolution(params);
    expect(result.source).toBe('dynamic');
    expect(result.models.map(model => model.id)).toEqual(ids);
    expect(result.miniMaxModelChoices).toEqual({ provider: 'minimax', configuredModelIds: ['MiniMax-M3.1-Flash'] });
    expect(projectMiniMaxModelChoices(result.models, result.miniMaxModelChoices).map(model => model.id)).toEqual([
      'MiniMax-M3.1-Flash', 'MiniMax-M3', 'speech-02-hd',
    ]);
    const legacy = await resolveClaudeModelCatalogResolution({ ...params, processEnv: {
      ...params.processEnv, [`${prefix}_MODEL`]: 'MiniMax-M2.7',
    } });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(legacy.models).toEqual(result.models);
    expect(projectMiniMaxModelChoices(legacy.models, legacy.miniMaxModelChoices).map(model => model.id)).toContain('MiniMax-M2.7');
  });

  it('retains full membership and presentation after malformed HTTP, and respects a later empty success', async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: ids.map(id => ({ id })) }), { status: 200 }))
      .mockResolvedValueOnce(new Response('{malformed', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', transport);
    const params = { profileId: 'minimax', credentials, accountSettings: {}, timeoutMs: 1000,
      processEnv: { MINIMAX_AUTH_TOKEN: 'fixture-key' }, bypassCache: true };
    const first = await resolveClaudeModelCatalogResolution(params);
    const failed = await resolveClaudeModelCatalogResolution(params);
    expect(failed.models).toEqual(first.models);
    expect(failed.miniMaxModelChoices).toEqual(first.miniMaxModelChoices);
    expect(failed.refreshError).toBe(true);
    const empty = await resolveClaudeModelCatalogResolution(params);
    expect(empty.source).toBe('dynamic');
    expect(empty.models).toEqual([]);
    expect(empty.miniMaxModelChoices).toEqual(first.miniMaxModelChoices);
  });

  it('does not apply direct MiniMax presentation to a custom profile endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async input => {
      expect(String(input)).toBe('https://gateway.example/anthropic/v1/models?limit=1000');
      return new Response(JSON.stringify({ data: ids.map(id => ({ id })) }), { status: 200 });
    }));
    const result = await resolveClaudeModelCatalogResolution({ profileId: 'minimax', credentials, accountSettings: {}, timeoutMs: 1000,
      processEnv: { MINIMAX_AUTH_TOKEN: 'fixture-key', MINIMAX_BASE_URL: 'https://gateway.example/anthropic' } });
    expect(result.miniMaxModelChoices).toBeUndefined();
    expect(result.models.map(model => model.id)).toEqual(ids);
  });
});
