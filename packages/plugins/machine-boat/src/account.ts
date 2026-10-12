import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountAuthenticationContext, ConnectedAccountReadContext, ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpMethod } from '@happier-dev/plugin-sdk/http';
import { createBoatNativeClient } from './machine/nativeClient.js';
import { BoatNativeError } from './machine/schemas.js';

export const ACCOUNT_ID = 'boat-account';
export const ACCOUNT_PURPOSE = 'cloud-api';
const ORIGIN = 'https://boat.dev';
const diagnostic = { code: 'credential_unavailable', severity: 'error' as const, message: 'Boat API access could not be confirmed.' };
const validToken = (value: string | null | undefined) => typeof value === 'string' && value.trim() !== '' && !/[\r\n]/.test(value);

export function nativeFetch(context: Pick<PluginInvocationContext, 'services' | 'signal'>, token?: string): typeof globalThis.fetch {
  return async (input, init) => {
    const url = String(input);
    if (new URL(url).origin !== ORIGIN) throw new Error('provider_unavailable');
    const method = init?.method ?? 'GET';
    if (!['GET', 'POST', 'DELETE'].includes(method)) throw new Error('invalid_request');
    const signal = init?.signal ?? context.signal;
    const material = token === undefined
      ? await context.services.connectedAccounts.materialize(ACCOUNT_PURPOSE,
        { kind: 'httpHeaders', origin: ORIGIN, headerNames: ['authorization'] }, { signal })
      : { kind: 'httpHeaders' as const, headers: { Authorization: `Bearer ${token}` } };
    if (material.kind !== 'httpHeaders') throw new Error('credential_unavailable');
    const authorization = new Headers(material.headers).get('authorization');
    if (!authorization) throw new Error('credential_unavailable');
    const headers = new Headers(init?.headers);
    headers.set('Authorization', authorization);
    const response = await context.services.http.request({
      url, method: method as HttpMethod, headers: Object.fromEntries(headers.entries()), redirect: 'error',
      ...(init?.body === undefined ? {} : { body: new TextEncoder().encode(String(init.body)) }),
    }, { signal });
    if (response.finalUrl !== url) throw new Error('provider_unavailable');
    return new Response(response.status === 204 ? null : new Uint8Array(response.body), { status: response.status, headers: response.headers });
  };
}

async function confirm(token: string, context: ConnectedAccountAuthenticationContext | ConnectedAccountReadContext, options?: { signal?: AbortSignal }) {
  try {
    await createBoatNativeClient({ fetch: nativeFetch(context, token), signal: options?.signal ?? context.signal }).check();
    return 'connected' as const;
  } catch (error) {
    if ((options?.signal ?? context.signal).aborted) throw error;
    return error instanceof BoatNativeError && error.code === 'native_authorization_failed'
      ? 'reconnectRequired' as const : 'unavailable' as const;
  }
}

async function health(context: ConnectedAccountReadContext, options?: { signal?: AbortSignal }) {
  const token = await context.credentials.get('token', options);
  const status = validToken(token) ? await confirm(token!, context, options) : 'reconnectRequired' as const;
  return status === 'connected' ? { status, displayName: 'Boat' } : { status, diagnostic };
}

export const connectedAccountRuntime: ConnectedAccountRuntime = {
  authentication: { modes: { token: { kind: 'manual', async complete(input, context, options) {
    const token = input.fields.token?.trim();
    if (!validToken(token)) return { status: 'rejected', diagnostic };
    const status = await confirm(token!, context, options);
    if (status === 'unavailable') return { status, diagnostic };
    if (status !== 'connected') return { status: 'rejected', diagnostic };
    await context.attemptCredentials.set('token', token!, options);
    return { status: 'connected', displayName: 'Boat', scopes: [] };
  } } } },
  status: health,
  refresh: health,
  async revoke() { return { status: 'remoteUnsupported' }; },
  async materialize(request, context, options) {
    if (request.kind !== 'httpHeaders' || request.origin !== ORIGIN
      || request.headerNames.some(name => name.toLowerCase() !== 'authorization')) throw new Error('credential_unavailable');
    const token = await context.credentials.get('token', options);
    if (!validToken(token)) throw new Error('credential_unavailable');
    return { kind: 'httpHeaders', headers: { Authorization: `Bearer ${token}` } };
  },
};
