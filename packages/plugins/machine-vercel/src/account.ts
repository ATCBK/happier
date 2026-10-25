import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountAuthenticationContext, ConnectedAccountMaterialization, ConnectedAccountReadContext, ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpMethod } from '@happier-dev/plugin-sdk/http';

export const ACCOUNT_ID = 'vercel-account';
export const ACCOUNT_PURPOSE = 'cloud-api';
const origin = 'https://api.vercel.com';
const scopeKeys = ['VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID'] as const;
const diagnostic = { code: 'credential_unavailable', severity: 'error' as const,
  message: 'Vercel API access could not be confirmed. Check the token, team, and project.' };
type AccountScope = { teamId: string; projectId: string };
type Invocation = Pick<PluginInvocationContext, 'services' | 'signal'>;

function failure(code: 'credential_unavailable' | 'provider_unavailable' | 'invalid_request') {
  return Object.assign(new Error(code), { code });
}

function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/\s/u.test(value);
}

function configuredScope(values: Readonly<Record<string, unknown>>): AccountScope | null {
  const { teamId, projectId } = values;
  if (typeof teamId !== 'string' || !teamId.trim() || /[\r\n]/u.test(teamId)
    || typeof projectId !== 'string' || !projectId.trim() || /[\r\n]/u.test(projectId)) return null;
  return { teamId: teamId.trim(), projectId: projectId.trim() };
}

/** Both IDs come from the host's exact selected Connected Account, never launch input. */
export async function readAccountScope(context: Invocation): Promise<AccountScope> {
  context.signal.throwIfAborted();
  try {
    const material = await context.services.connectedAccounts.materialize(ACCOUNT_PURPOSE,
      { kind: 'environment', keys: scopeKeys }, { signal: context.signal });
    context.signal.throwIfAborted();
    const scope = material.kind === 'environment'
      ? configuredScope({ teamId: material.env.VERCEL_TEAM_ID, projectId: material.env.VERCEL_PROJECT_ID }) : null;
    if (!scope) throw failure('credential_unavailable');
    return scope;
  } catch {
    context.signal.throwIfAborted();
    throw failure('credential_unavailable');
  }
}

/** Vendor IO stays on host HTTP; each request captures its own admitted credential. */
export function nativeFetch(context: Invocation, token?: string): typeof fetch {
  return async (input, init) => {
    context.signal.throwIfAborted();
    let url: URL;
    try { url = new URL(input instanceof Request ? input.url : String(input)); }
    catch { throw failure('provider_unavailable'); }
    if (url.origin !== origin || url.username || url.password) throw failure('provider_unavailable');
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (!['GET', 'POST', 'DELETE', 'PATCH'].includes(method)) throw failure('invalid_request');
    let request: Request;
    try { request = new Request(input, init); }
    catch { throw failure('invalid_request'); }
    const signal = AbortSignal.any([context.signal, request.signal]);
    signal.throwIfAborted();
    let authorization: string | null;
    try {
      const material = token === undefined
        ? await context.services.connectedAccounts.materialize(ACCOUNT_PURPOSE,
          { kind: 'httpHeaders', origin, headerNames: ['authorization'] }, { signal })
        : validToken(token) ? { kind: 'httpHeaders' as const, headers: { Authorization: `Bearer ${token}` } } : null;
      authorization = material?.kind === 'httpHeaders' ? new Headers(material.headers).get('authorization') : null;
      if (!authorization) throw failure('credential_unavailable');
    } catch {
      signal.throwIfAborted();
      throw failure('credential_unavailable');
    }
    signal.throwIfAborted();
    const headers = new Headers(request.headers);
    headers.set('authorization', authorization);
    try {
      const body = request.body === null ? undefined : new Uint8Array(await request.arrayBuffer());
      signal.throwIfAborted();
      const response = await context.services.http.request({ url: request.url, method: method as HttpMethod,
        headers: Object.fromEntries(headers.entries()), redirect: 'error', ...(body === undefined ? {} : { body }),
      }, { signal });
      signal.throwIfAborted();
      if (response.finalUrl !== request.url || (response.status >= 300 && response.status < 400)) {
        throw failure('provider_unavailable');
      }
      return new Response(response.status === 204 || response.status === 205 ? null : new Uint8Array(response.body),
        { status: response.status, headers: response.headers });
    } catch {
      signal.throwIfAborted();
      throw failure('provider_unavailable');
    }
  };
}

// Official REST v9 project lookup: https://vercel.com/docs/rest-api/projects/find-a-project-by-id-or-name
async function confirm(token: string, context: ConnectedAccountAuthenticationContext | ConnectedAccountReadContext, signal: AbortSignal) {
  signal.throwIfAborted();
  const scope = configuredScope(context.configuration.values);
  if (!scope) return 'reconnectRequired' as const;
  try {
    const url = new URL(`${origin}/v9/projects/${encodeURIComponent(scope.projectId)}`);
    url.searchParams.set('teamId', scope.teamId);
    const response = await nativeFetch({ services: context.services, signal }, token)(url);
    if ([401, 403, 404].includes(response.status)) return 'reconnectRequired' as const;
    if (!response.ok) return 'unavailable' as const;
    const project: unknown = await response.json();
    return typeof project === 'object' && project !== null && 'id' in project && project.id === scope.projectId
      ? 'connected' as const : 'reconnectRequired' as const;
  } catch {
    signal.throwIfAborted();
    return 'unavailable' as const;
  }
}

async function health(context: ConnectedAccountReadContext, options?: { signal?: AbortSignal }) {
  const signal = options?.signal ? AbortSignal.any([context.signal, options.signal]) : context.signal;
  signal.throwIfAborted();
  try {
    const token = await context.credentials.get('token', { signal });
    signal.throwIfAborted();
    const status = validToken(token) ? await confirm(token, context, signal) : 'reconnectRequired' as const;
    return status === 'connected' ? { status, displayName: 'Vercel' } : { status, diagnostic };
  } catch {
    signal.throwIfAborted();
    return { status: 'unavailable' as const, diagnostic };
  }
}

export const connectedAccountRuntime: ConnectedAccountRuntime = {
  authentication: { modes: { token: { kind: 'manual', async complete(input, context, options) {
    const signal = options?.signal ? AbortSignal.any([context.signal, options.signal]) : context.signal;
    signal.throwIfAborted();
    const supplied = input.fields.token;
    const token = supplied?.trim();
    if (typeof supplied !== 'string' || /[\r\n]/u.test(supplied) || !validToken(token)) return { status: 'rejected', diagnostic };
    const status = await confirm(token, context, signal);
    if (status === 'unavailable') return { status, diagnostic };
    if (status !== 'connected') return { status: 'rejected', diagnostic };
    signal.throwIfAborted();
    try { await context.attemptCredentials.set('token', token, { signal }); }
    catch {
      signal.throwIfAborted();
      return { status: 'unavailable', diagnostic };
    }
    signal.throwIfAborted();
    return { status: 'connected', displayName: 'Vercel', scopes: [] };
  } } } },
  status: health,
  refresh: health,
  async revoke() { return { status: 'remoteUnsupported' }; },
  async materialize(request, context, options): Promise<ConnectedAccountMaterialization> {
    const signal = options?.signal ? AbortSignal.any([context.signal, options.signal]) : context.signal;
    signal.throwIfAborted();
    if (request.kind === 'environment' && request.keys.every(key => scopeKeys.some(allowed => key === allowed))) {
      const scope = configuredScope(context.configuration.values);
      if (!scope) throw failure('credential_unavailable');
      const values = { VERCEL_TEAM_ID: scope.teamId, VERCEL_PROJECT_ID: scope.projectId };
      return { kind: 'environment', env: Object.fromEntries(request.keys.map(key => [key, values[key as keyof typeof values]])) };
    }
    if (request.kind !== 'httpHeaders' || request.origin !== origin
      || request.headerNames.some(name => name.toLowerCase() !== 'authorization')) throw failure('credential_unavailable');
    if (request.headerNames.length === 0) return { kind: 'httpHeaders', headers: {} };
    try {
      const token = await context.credentials.get('token', { signal });
      signal.throwIfAborted();
      if (!validToken(token)) throw failure('credential_unavailable');
      return { kind: 'httpHeaders', headers: { Authorization: `Bearer ${token}` } };
    } catch {
      signal.throwIfAborted();
      throw failure('credential_unavailable');
    }
  },
};
