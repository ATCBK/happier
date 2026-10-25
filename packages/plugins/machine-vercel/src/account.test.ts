import { describe, expect, it } from 'vitest';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountAuthenticationContext, ConnectedAccountReadContext } from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpRequest, HttpResponse } from '@happier-dev/plugin-sdk/http';
import { ACCOUNT_PURPOSE, connectedAccountRuntime, nativeFetch, readAccountScope } from './account.js';

const privateToken = 'private-vercel-token';
const scope = { teamId: 'team-selected', projectId: 'prj-selected' };

// Only the host credential store, selected-account service and vendor HTTP are substituted.
function fixture(options: { status?: number; value?: unknown; token?: string | null; configuration?: Record<string, string>; finalUrl?: string; failure?: Error; writeFailure?: Error } = {}) {
  const controller = new AbortController();
  const requests: HttpRequest[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const writes = new Map<string, string>();
  const materializations: { purpose: string; request: unknown }[] = [];
  const values = options.configuration ?? scope;
  const services = {
    connectedAccounts: { async materialize(purpose: string, request: { kind: string }) {
      materializations.push({ purpose, request });
      return request.kind === 'environment'
        ? { kind: 'environment', env: { VERCEL_TEAM_ID: values.teamId, VERCEL_PROJECT_ID: values.projectId } }
        : { kind: 'httpHeaders', headers: { Authorization: `Bearer ${privateToken}` } };
    } },
    http: { async request(request: HttpRequest, cancellation?: { signal?: AbortSignal }): Promise<HttpResponse> {
      requests.push(request);
      signals.push(cancellation?.signal);
      if (options.failure) throw options.failure;
      return { status: options.status ?? 200, finalUrl: options.finalUrl ?? request.url, headers: {},
        body: new TextEncoder().encode(JSON.stringify(options.value ?? { id: scope.projectId })) };
    } },
  };
  const common = { signal: controller.signal, services,
    configuration: { values },
    credentials: { get: async () => options.token === undefined ? privateToken : options.token },
  };
  // Account callbacks receive full host contexts; the fixture supplies only consumed boundary capabilities.
  const read = common as unknown as ConnectedAccountReadContext;
  const authentication = { ...common, attempt: { kind: 'connect', attemptId: 'attempt-1' },
    attemptCredentials: { async set(key: string, value: string) {
      if (options.writeFailure) throw options.writeFailure;
      writes.set(key, value);
    } },
  } as unknown as ConnectedAccountAuthenticationContext;
  return { read, authentication, action: common as unknown as PluginInvocationContext,
    requests, signals, writes, materializations, controller };
}

function manual() {
  const mode = connectedAccountRuntime.authentication.modes.token;
  if (mode?.kind !== 'manual') throw new Error('manual authentication mode required');
  return mode;
}

describe('Vercel selected Connected Account', () => {
  it('verifies the exact selected project once before retaining a manual token', async () => {
    const host = fixture();
    expect(await manual().complete({ fields: { token: privateToken } }, host.authentication)).toMatchObject({ status: 'connected' });
    expect(host.writes).toEqual(new Map([['token', privateToken]]));
    expect(host.requests).toMatchObject([{ url: 'https://api.vercel.com/v9/projects/prj-selected?teamId=team-selected',
      method: 'GET', headers: { authorization: `Bearer ${privateToken}` }, redirect: 'error' }]);
    expect(host.requests).toHaveLength(1);
    expect(host.materializations).toEqual([]);
  });

  it.each([
    { status: 401, expected: 'rejected' }, { status: 403, expected: 'rejected' },
    { status: 404, expected: 'rejected' }, { status: 503, expected: 'unavailable' },
    { status: 200, value: { id: 'another-project' }, expected: 'rejected' },
    { status: 200, value: {}, expected: 'rejected' },
  ])('does not retain a token when verification returns $status/$expected', async test => {
    const host = fixture(test);
    const result = await manual().complete({ fields: { token: privateToken } }, host.authentication);
    expect(result.status).toBe(test.expected);
    expect(host.writes.size).toBe(0);
    expect(JSON.stringify(result)).not.toContain(privateToken);
  });

  it.each([
    { status: 200, expected: 'connected' }, { status: 403, expected: 'reconnectRequired' },
    { status: 503, expected: 'unavailable' }, { status: 200, token: null, expected: 'reconnectRequired' },
  ])('reports account health without confusing rejected credentials with unavailable HTTP', async test => {
    const host = fixture(test);
    expect(await connectedAccountRuntime.status(host.read)).toMatchObject({ status: test.expected });
    expect(host.requests).toHaveLength(test.token === null ? 0 : 1);
  });

  it('rejects missing project scope and malformed tokens before issuing HTTP', async () => {
    const missing = fixture({ configuration: { teamId: scope.teamId } });
    expect(await manual().complete({ fields: { token: privateToken } }, missing.authentication)).toMatchObject({ status: 'rejected' });
    expect(missing.requests).toEqual([]);
    const malformed = fixture();
    expect(await manual().complete({ fields: { token: 'bad\r\nheader' } }, malformed.authentication)).toMatchObject({ status: 'rejected' });
    expect(malformed.requests).toEqual([]);
    expect(malformed.writes.size).toBe(0);
  });

  it('materializes only requested nonsecret scope keys and exact API authorization', async () => {
    const host = fixture();
    expect(await connectedAccountRuntime.materialize({ kind: 'environment', keys: ['VERCEL_PROJECT_ID'] }, host.read))
      .toEqual({ kind: 'environment', env: { VERCEL_PROJECT_ID: scope.projectId } });
    expect(await connectedAccountRuntime.materialize({ kind: 'httpHeaders', origin: 'https://api.vercel.com', headerNames: ['authorization'] }, host.read))
      .toEqual({ kind: 'httpHeaders', headers: { Authorization: `Bearer ${privateToken}` } });
    for (const request of [
      { kind: 'environment' as const, keys: ['VERCEL_TOKEN'] },
      { kind: 'httpHeaders' as const, origin: 'https://example.com', headerNames: ['authorization'] },
      { kind: 'httpHeaders' as const, origin: 'https://api.vercel.com', headerNames: ['cookie'] },
    ]) await expect(connectedAccountRuntime.materialize(request, host.read)).rejects.toThrow('credential_unavailable');
  });

  it('reads scope only from the selected account materialization', async () => {
    const host = fixture();
    expect(await readAccountScope(host.action)).toEqual(scope);
    expect(host.materializations).toEqual([{ purpose: ACCOUNT_PURPOSE,
      request: { kind: 'environment', keys: ['VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID'] } }]);
    expect(host.requests).toEqual([]);
    await expect(readAccountScope(fixture({ configuration: { teamId: scope.teamId } }).action))
      .rejects.toThrow('credential_unavailable');
  });

  it('keeps vendor errors private and propagates cancellation', async () => {
    const host = fixture({ failure: new Error(`request with ${privateToken} failed`) });
    const health = await connectedAccountRuntime.status(host.read);
    expect(health.status).toBe('unavailable');
    expect(JSON.stringify(health)).not.toContain(privateToken);
    const completion = await manual().complete({ fields: { token: privateToken } }, host.authentication);
    expect(completion.status).toBe('unavailable');
    expect(JSON.stringify(completion)).not.toContain(privateToken);
    host.controller.abort();
    await expect(connectedAccountRuntime.status(host.read)).rejects.toThrow();
    expect(host.writes.size).toBe(0);
  });

  it('keeps credential storage failures private after successful project verification', async () => {
    const host = fixture({ writeFailure: new Error(`failed to store ${privateToken}`) });
    const result = await manual().complete({ fields: { token: privateToken } }, host.authentication);
    expect(result.status).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain(privateToken);
    expect(host.writes.size).toBe(0);
  });
});

describe('Vercel host-bound HTTP', () => {
  it('captures authorization for each request and preserves binary and text bodies', async () => {
    const host = fixture();
    const fetcher = nativeFetch(host.action);
    const bytes = new Uint8Array([0, 255, 128, 42]);
    await fetcher('https://api.vercel.com/v3/sandboxes', { method: 'POST', body: bytes,
      headers: { Authorization: 'caller-token', 'content-type': 'application/octet-stream' } });
    await fetcher('https://api.vercel.com/v2/sandboxes/one', { method: 'PATCH', body: '{"timeout":1}' });
    expect(host.requests[0]?.body).toEqual(bytes);
    expect(new TextDecoder().decode(host.requests[1]?.body)).toBe('{"timeout":1}');
    expect(host.requests.every(request => request.redirect === 'error' && request.headers?.authorization === `Bearer ${privateToken}`)).toBe(true);
    expect(host.materializations).toHaveLength(2);
  });

  it('refuses foreign origins, URL credentials, unsupported methods and redirected responses', async () => {
    const host = fixture();
    const fetcher = nativeFetch(host.action);
    await expect(fetcher('https://example.com')).rejects.toThrow('provider_unavailable');
    await expect(fetcher('https://user:secret@api.vercel.com/v2/sandboxes')).rejects.toThrow('provider_unavailable');
    await expect(fetcher('https://api.vercel.com/v2/sandboxes', { method: 'PUT' })).rejects.toThrow('invalid_request');
    expect(host.requests).toEqual([]);
    const redirect = fixture({ status: 302, finalUrl: 'https://example.com' });
    await expect(nativeFetch(redirect.action)('https://api.vercel.com/v2/sandboxes')).rejects.toThrow('provider_unavailable');
    const sameOriginRedirect = fixture({ status: 307 });
    await expect(nativeFetch(sameOriginRedirect.action)('https://api.vercel.com/v2/sandboxes')).rejects.toThrow('provider_unavailable');
    const failure = fixture({ failure: new Error(`HTTP failure with ${privateToken}`) });
    await expect(nativeFetch(failure.action)('https://api.vercel.com/v2/sandboxes')).rejects.toThrow('provider_unavailable');
  });

  it('preserves invocation cancellation even when the caller supplies another signal', async () => {
    const host = fixture();
    await nativeFetch(host.action)('https://api.vercel.com/v2/sandboxes', { signal: new AbortController().signal });
    expect(host.signals[0]?.aborted).toBe(false);
    host.controller.abort();
    expect(host.signals[0]?.aborted).toBe(true);
    await expect(nativeFetch(host.action)('https://api.vercel.com/v2/sandboxes')).rejects.toThrow();
    expect(host.requests).toHaveLength(1);
  });
});
