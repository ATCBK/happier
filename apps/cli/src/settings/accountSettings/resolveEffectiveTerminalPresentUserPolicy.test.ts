import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';

const envPolicy = vi.hoisted(() => ({ value: undefined as 'allowed' | 'disallowed' | undefined }));
vi.mock('@/configuration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configuration')>();
  return { ...actual, configuration: { ...actual.configuration,
    get terminalPresentUserPolicy() { return envPolicy.value; },
  } };
});
import { initializeTerminalPresentUserPolicy, refreshTerminalPresentUserPolicy, resolveEffectiveTerminalPresentUserPolicy } from './resolveEffectiveTerminalPresentUserPolicy';

describe('effective terminal present-user policy', () => {
  it('authenticates a refreshed same-Account bearer after the older credential failed initialization', async () => {
    const token = (issuance: number) => `test.${Buffer.from(JSON.stringify({ sub: 'rotated-security-account', iat: issuance })).toString('base64url')}.test`;
    const scope = { token: token(1), serverHttpBaseUrl: 'https://rotated-policy.example.com' };
    const get = vi.spyOn(axios, 'get').mockRejectedValueOnce(new Error('Old credential unavailable'))
      .mockResolvedValueOnce({ status: 200, data: {
        v: 1, encryptionMode: 'plain', nativeEmail: null,
        password: { status: 'not_enrolled', revision: null }, terminalPresentUserPolicy: 'disallowed',
      } });
    try {
      expect(await initializeTerminalPresentUserPolicy(scope)).toBe('allowed');
      expect(await initializeTerminalPresentUserPolicy({ ...scope, token: token(2) })).toBe('disallowed');
    } finally { get.mockRestore(); }
  });

  it('initializes once per credential and Home but explicitly refreshes for reconnect', async () => {
    const scope = { token: 'initialize-policy-test', serverHttpBaseUrl: 'https://initialize-policy.example.com/' };
    const get = vi.spyOn(axios, 'get').mockRejectedValueOnce(new Error('initially offline'))
      .mockResolvedValueOnce({ status: 200, data: {
        v: 1, encryptionMode: 'plain', nativeEmail: null,
        password: { status: 'not_enrolled', revision: null }, terminalPresentUserPolicy: 'disallowed',
      } });
    try {
      expect(await initializeTerminalPresentUserPolicy(scope)).toBe('allowed');
      expect(await initializeTerminalPresentUserPolicy({ ...scope, serverHttpBaseUrl: scope.serverHttpBaseUrl.slice(0, -1) })).toBe('allowed');
      expect(await refreshTerminalPresentUserPolicy(scope)).toBe('disallowed');
      get.mockRejectedValueOnce(new Error('different scope remains independent'));
      expect(await initializeTerminalPresentUserPolicy({ ...scope, token: 'another-terminal' })).toBe('allowed');
      expect(get.mock.calls.map(([url]) => url)).toHaveLength(3);
    } finally { get.mockRestore(); }
  });

  it('makes concurrent consumers wait for the same pending policy observation', async () => {
    const scope = { token: 'pending-policy-test', serverHttpBaseUrl: 'https://pending-policy.example.com' };
    let resolveResponse!: (response: { status: number; data: unknown }) => void;
    const pendingResponse = new Promise<{ status: number; data: unknown }>((resolve) => { resolveResponse = resolve; });
    const get = vi.spyOn(axios, 'get').mockImplementationOnce(() => pendingResponse)
      .mockRejectedValueOnce(new Error('second request should not supersede the pending observation'));
    try {
      const first = refreshTerminalPresentUserPolicy(scope);
      const concurrent = refreshTerminalPresentUserPolicy(scope);
      resolveResponse({ status: 200, data: {
        v: 1, encryptionMode: 'plain', nativeEmail: null,
        password: { status: 'not_enrolled', revision: null }, terminalPresentUserPolicy: 'disallowed',
      } });
      expect(await first).toBe('disallowed');
      expect(await concurrent).toBe('disallowed');
    } finally { get.mockRestore(); }
  });

  it('retains the last readable security policy, defaults allowed, and always obeys the machine opt-out', async () => {
    const scope = { token: 'policy-cache-test', serverHttpBaseUrl: 'https://terminal-policy.example.com' };
    const get = vi.spyOn(axios, 'get');
    try {
      get.mockRejectedValueOnce(new Error('offline'));
      expect(await refreshTerminalPresentUserPolicy(scope)).toBe('allowed');
      get.mockResolvedValueOnce({ status: 200, data: {
        v: 1, encryptionMode: 'e2ee', nativeEmail: null,
        password: { status: 'not_enrolled', revision: null }, terminalPresentUserPolicy: 'disallowed',
      } });
      expect(await refreshTerminalPresentUserPolicy(scope)).toBe('disallowed');
      get.mockResolvedValueOnce({ status: 200, data: { terminalPresentUserPolicy: 'sometimes' } });
      expect(await refreshTerminalPresentUserPolicy(scope)).toBe('disallowed');
      expect(resolveEffectiveTerminalPresentUserPolicy({ ...scope, token: 'different-account' })).toBe('allowed');
      expect(resolveEffectiveTerminalPresentUserPolicy({ ...scope, serverHttpBaseUrl: 'https://another-home.example.com' })).toBe('allowed');
      envPolicy.value = 'disallowed';
      expect(resolveEffectiveTerminalPresentUserPolicy({ ...scope, token: 'different-account' })).toBe('disallowed');
      get.mockRejectedValueOnce(new Error('offline'));
      expect(await refreshTerminalPresentUserPolicy({ ...scope, token: 'different-account' })).toBe('disallowed');
    } finally { envPolicy.value = undefined; get.mockRestore(); }
  });
});
