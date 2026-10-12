import { afterEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ OS: 'web' }));
const nativeFetch = vi.hoisted(() => ({ loaded: false, fetch: vi.fn() }));
vi.mock('react-native', () => ({ Platform: platform }));
// Expo and the browser fetch are the native/HTTP system boundaries.
vi.mock('expo/fetch', () => {
  nativeFetch.loaded = true;
  return { fetch: nativeFetch.fetch };
});

afterEach(() => {
  platform.OS = 'web';
  vi.unstubAllGlobals();
  vi.resetModules();
  nativeFetch.loaded = false;
  nativeFetch.fetch.mockReset();
});

describe('portable OpenAI provider fetch', () => {
  it('keeps native fetch unevaluated during web signaling', async () => {
    const response = new Response('browser answer');
    const webFetch = vi.fn(async () => response);
    vi.stubGlobal('fetch', webFetch);
    const { openAiProviderFetch } = await import('./providerFetch.js');
    const init = { method: 'POST', redirect: 'error' as const, signal: new AbortController().signal };
    expect(await openAiProviderFetch('https://api.openai.com/v1/realtime/calls', init)).toBe(response);
    expect(webFetch).toHaveBeenCalledWith('https://api.openai.com/v1/realtime/calls', init);
    expect(nativeFetch.loaded).toBe(false);
  });

  it.each(['ios', 'android'])('uses Expo fetch on %s while preserving cancellation and redirect policy', async (os) => {
    platform.OS = os;
    const response = new Response('native answer');
    nativeFetch.fetch.mockResolvedValue(response);
    const webFetch = vi.fn();
    vi.stubGlobal('fetch', webFetch);
    const { openAiProviderFetch } = await import('./providerFetch.js');
    expect(nativeFetch.loaded).toBe(false);
    const init = { method: 'POST', redirect: 'error' as const, signal: new AbortController().signal };
    expect(await openAiProviderFetch('https://api.openai.com/v1/realtime/calls', init)).toBe(response);
    expect(nativeFetch.fetch).toHaveBeenCalledWith('https://api.openai.com/v1/realtime/calls', init);
    expect(webFetch).not.toHaveBeenCalled();
  });
});
