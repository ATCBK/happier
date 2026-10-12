import type { HttpService } from '@happier-dev/plugin-sdk/http';

export class EmailCredentialError extends Error {
  constructor(readonly reason: 'credentialInvalid' | 'invalidConfiguration' | 'network') {
    super(`Email credentials are unavailable (${reason})`);
  }
}

export async function requestMicrosoftAppOnlyToken(
  application: Readonly<{ tenantId: string; clientId: string; clientSecret: string }>,
  http: Pick<HttpService, 'request'>,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(application.tenantId) || !application.clientId || !application.clientSecret) {
    throw new EmailCredentialError('invalidConfiguration');
  }
  const url = `https://login.microsoftonline.com/${application.tenantId}/oauth2/v2.0/token`;
  const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: application.clientId,
    client_secret: application.clientSecret, scope: 'https://outlook.office365.com/.default' });
  const response = await http.request({ url, method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: Buffer.from(form.toString()) }, { signal });
  signal?.throwIfAborted();
  if (response.status !== 200) throw new EmailCredentialError(response.status >= 500 || response.status === 429 ? 'network' : 'credentialInvalid');
  let value: unknown;
  try { value = JSON.parse(Buffer.from(response.body).toString()); }
  catch { throw new EmailCredentialError('credentialInvalid'); }
  if (!value || typeof value !== 'object' || !('access_token' in value)
    || typeof value.access_token !== 'string' || !value.access_token.trim()) throw new EmailCredentialError('credentialInvalid');
  return value.access_token;
}
