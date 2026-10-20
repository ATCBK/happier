import { describe, expect, it } from 'vitest';
import { slackConnectedAccountRuntime } from './connectedAccountRuntime.js';

const mode = slackConnectedAccountRuntime.authentication.modes['bot-tokens'];
if (!mode || mode.kind !== 'manual') throw new Error('Expected Slack manual bot-tokens authentication');
const complete = mode.complete;
type Context = Parameters<typeof complete>[1];

function context(stored: Map<string, string>, appAccepted = true): Context {
  return {
    signal: new AbortController().signal,
    services: { http: { async request(input: Readonly<{ url: string }>) {
      const data = input.url.includes('auth.test')
        ? { ok: true, team_id: 'T1', user_id: 'U1', bot_id: 'B1' }
        : input.url.includes('bots.info')
          ? { ok: true, bot: { id: 'B1', user_id: 'U1', app_id: 'A1', name: 'Happier' } }
          : appAccepted ? { ok: true, url: 'wss://wss-primary.slack.com/link?ticket=secret' } : { ok: false, error: 'invalid_auth' };
      return { status: 200, finalUrl: input.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(data)) };
    } } },
    attemptCredentials: {
      async get(key: string) { return stored.get(key) ?? null; },
      async set(key: string, value: string) { stored.set(key, value); },
      async delete(key: string) { stored.delete(key); },
    },
  } as Context;
}

describe('Slack Connected Account runtime', () => {
  it('stores both credentials only after bot identity and Socket Mode credential verification', async () => {
    const stored = new Map<string, string>();
    await expect(complete({ fields: { botToken: ' xoxb-test ', appToken: ' xapp-test ' } }, context(stored))).resolves.toEqual({
      status: 'connected', accountId: 'team:T1:app:A1:bot:U1',
      providerIdentity: { accountId: 'T1:A1:U1' }, displayName: 'Happier', scopes: [],
    });
    expect(stored).toEqual(new Map([['botToken', 'xoxb-test'], ['appToken', 'xapp-test']]));
  });

  it('does not retain a valid bot token when the app credential is rejected', async () => {
    const stored = new Map<string, string>();
    await expect(complete({ fields: { botToken: 'xoxb-test', appToken: 'xapp-test' } }, context(stored, false)))
      .resolves.toMatchObject({ status: 'rejected' });
    expect(stored.size).toBe(0);
  });

  it('does not retain credentials after cancellation during the final provider probe', async () => {
    const stored = new Map<string, string>();
    const controller = new AbortController();
    const ctx = { ...context(stored), signal: controller.signal };
    const request = ctx.services.http.request;
    ctx.services.http.request = async (input, options) => {
      const result = await request(input, options);
      if (input.url.includes('apps.connections.open')) controller.abort();
      return result;
    };
    await expect(complete({ fields: { botToken: 'xoxb-test', appToken: 'xapp-test' } }, ctx))
      .resolves.toMatchObject({ status: 'unavailable' });
    expect(stored.size).toBe(0);
  });

  it('rejects the wrong token families before making an authenticated request', async () => {
    const stored = new Map<string, string>();
    const ctx = context(stored);
    ctx.services.http.request = async () => { throw new Error('Must not send invalid token families'); };
    await expect(complete({ fields: { botToken: 'xapp-wrong', appToken: 'xoxb-wrong' } }, ctx))
      .resolves.toMatchObject({ status: 'rejected' });
    expect(stored.size).toBe(0);
  });

  it('materializes only explicitly requested credential environment keys', async () => {
    const credentials = { async get(key: string) { return key === 'botToken' ? 'xoxb-test' : key === 'appToken' ? 'xapp-test' : null; } };
    const ctx = { credentials } as Parameters<typeof slackConnectedAccountRuntime.materialize>[1];
    await expect(slackConnectedAccountRuntime.materialize({ kind: 'environment', keys: ['SLACK_BOT_TOKEN', 'UNRELATED'] }, ctx))
      .resolves.toEqual({ kind: 'environment', env: { SLACK_BOT_TOKEN: 'xoxb-test' } });
    await expect(slackConnectedAccountRuntime.materialize({ kind: 'environment', keys: ['SLACK_APP_TOKEN'] }, ctx))
      .resolves.toEqual({ kind: 'environment', env: { SLACK_APP_TOKEN: 'xapp-test' } });
  });

  it('rechecks both credentials for health and exposes revoked credentials as reconnect-required', async () => {
    const stored = new Map([['botToken', 'xoxb-test'], ['appToken', 'xapp-test']]);
    const authContext = context(stored);
    const readContext = {
      signal: authContext.signal, services: authContext.services, credentials: authContext.attemptCredentials,
    } as Parameters<typeof slackConnectedAccountRuntime.status>[0];
    await expect(slackConnectedAccountRuntime.status(readContext)).resolves.toMatchObject({ status: 'connected', displayName: 'Happier' });
    const rejected = context(stored, false);
    await expect(slackConnectedAccountRuntime.status({ ...readContext, services: rejected.services }))
      .resolves.toMatchObject({ status: 'reconnectRequired' });
  });

  it('does not materialize an incomplete credential pair', async () => {
    const ctx = {
      credentials: { async get(key: string) { return key === 'botToken' ? 'xoxb-test' : null; } },
    } as Parameters<typeof slackConnectedAccountRuntime.materialize>[1];
    await expect(slackConnectedAccountRuntime.materialize({ kind: 'environment', keys: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'] }, ctx))
      .rejects.toThrow();
  });
});
