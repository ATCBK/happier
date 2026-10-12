import { describe, expect, it } from 'vitest';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import { requestMicrosoftAppOnlyToken as read } from './credentials';

type TokenRequest = Parameters<HttpService['request']>[0];
type TokenResponse = Awaited<ReturnType<HttpService['request']>>;
const application = { tenantId: 'tenant.example', clientId: 'application-id', clientSecret: 'secret&+value' };
const response = (status: number, value: unknown): TokenResponse => ({ status, finalUrl: 'https://login.microsoftonline.com/tenant.example/oauth2/v2.0/token', headers: {}, body: Buffer.from(JSON.stringify(value)) });

describe('Microsoft app-only credential boundary', () => {
  it('uses the exact tenant token endpoint and Outlook scope, form-encodes secrets, and forbids redirects', async () => {
    const requests: TokenRequest[] = [];
    const http: Pick<HttpService, 'request'> = { async request(input) { requests.push(input); return response(200, { access_token: 'testtoken', token_type: 'Bearer' }); } };
    expect(await read(application, http, new AbortController().signal)).toBe('testtoken');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: 'https://login.microsoftonline.com/tenant.example/oauth2/v2.0/token', method: 'POST', redirect: 'error' });
    const form = new URLSearchParams(Buffer.from(requests[0].body!).toString());
    expect(Object.fromEntries(form)).toEqual({ grant_type: 'client_credentials', client_id: application.clientId, client_secret: application.clientSecret, scope: 'https://outlook.office365.com/.default' });
  });

  it.each([[401, { error: 'invalid_client', error_description: application.clientSecret }], [200, {}], [200, { access_token: '', token_type: 'Bearer' }]] as const)(
    'rejects failed or malformed grants without including response secrets (HTTP %i)', async (status, value) => {
      const http: Pick<HttpService, 'request'> = { async request() { return response(status, value); } };
      let error: unknown;
      try { await read(application, http); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(application.clientSecret);
    },
  );

  it('rejects tenant path injection before any network request', async () => {
    let requested = false;
    const http: Pick<HttpService, 'request'> = { async request() { requested = true; return response(200, { access_token: 'testtoken' }); } };
    await expect(read({ ...application, tenantId: '../other?leak=' }, http)).rejects.toThrow();
    expect(requested).toBe(false);
  });

  it('propagates caller cancellation through the HTTP boundary', async () => {
    const abort = new AbortController();
    abort.abort(new Error('cancelled'));
    const http: Pick<HttpService, 'request'> = { async request(_input, options) { options?.signal?.throwIfAborted(); return response(200, { access_token: 'testtoken' }); } };
    await expect(read(application, http, abort.signal)).rejects.toThrow('cancelled');
  });
});
