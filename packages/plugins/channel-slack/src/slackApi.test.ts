import { describe, expect, it } from 'vitest';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import { ConversationDeliveryResultV1Schema } from '@happier-dev/channels-protocol/v1';
import { createSlackApi } from './slackApi.js';
import { createSlackMessagePayload } from './slackDelivery.js';

const credentials = { botToken: 'xoxb-test', appToken: 'xapp-test' };
function response(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return { status, headers, finalUrl: 'https://slack.com/api/', body: new TextEncoder().encode(JSON.stringify(body)) };
}
const identity = { teamId: 'T1', appId: 'A1', botUserId: 'U1', botId: 'B1', label: 'Happier' };
const payload = () => createSlackMessagePayload({ channelId: 'C1', text: 'hello', linkPreviewPolicy: 'suppress' });

describe('Slack Web API boundary', () => {
  it('proves correlated bot identity with bot credentials and opens Socket Mode only with the app token', async () => {
    const signal = new AbortController().signal;
    const http: Pick<HttpService, 'request'> = { async request(input, options) {
      expect(options?.signal).toBe(signal);
      expect(input.redirect).toBe('error');
      const url = new URL(input.url);
      const isOpen = url.pathname.endsWith('/apps.connections.open');
      expect(input.headers?.Authorization).toBe(`Bearer ${isOpen ? credentials.appToken : credentials.botToken}`);
      if (url.pathname.endsWith('/auth.test')) return response({ ok: true, team_id: 'T1', user_id: 'U1', bot_id: 'B1' });
      if (url.pathname.endsWith('/bots.info')) {
        expect(url.searchParams.get('bot')).toBe('B1');
        return response({ ok: true, bot: { id: 'B1', user_id: 'U1', app_id: 'A1', name: 'Happier' } });
      }
      if (isOpen) return response({ ok: true, url: 'wss://wss-primary.slack.com/link?ticket=secret' });
      throw new Error('Unexpected request');
    } };
    const api = createSlackApi({ credentials, http });
    await expect(api.getIdentity({ signal })).resolves.toEqual(identity);
    await expect(api.openConnection({ signal })).resolves.toEqual({ url: 'wss://wss-primary.slack.com/link?ticket=secret' });
  });

  it('rejects identity disagreement and unsafe socket URLs without disclosing provider payloads', async () => {
    const api = createSlackApi({ credentials, http: { async request(input) {
      return response(input.url.includes('auth.test')
        ? { ok: true, team_id: 'T1', user_id: 'U1', bot_id: 'B1' }
        : input.url.includes('bots.info')
          ? { ok: true, bot: { id: 'B1', user_id: 'OTHER', app_id: 'A1' } }
          : { ok: true, url: 'https://example.org/socket?token=xapp-secret' });
    } } });
    await expect(api.getIdentity()).resolves.toMatchObject({ kind: 'notReady', reason: 'invalidConfiguration' });
    await expect(api.openConnection()).resolves.toMatchObject({ kind: 'notReady', reason: 'invalidConfiguration' });
  });

  it('reads documented direct-channel omissions and authenticates immutable user IDs', async () => {
    const api = createSlackApi({ credentials, http: { async request(input) {
      const url = new URL(input.url);
      if (url.pathname.endsWith('/conversations.info')) {
        expect(url.searchParams.get('channel')).toBe('D1');
        return response({ ok: true, channel: { id: 'D1', is_im: true } });
      }
      expect(url.searchParams.get('user')).toBe('U2');
      return response({ ok: true, user: { id: 'U2', team_id: 'T1', is_bot: false, deleted: false, profile: { display_name: 'Alice' } } });
    } } });
    await expect(api.getChannel('D1')).resolves.toEqual({ id: 'D1', isIm: true, isMpim: false, isPrivate: true, isArchived: false });
    await expect(api.getUser('U2')).resolves.toEqual({ id: 'U2', teamId: 'T1', isBot: false, deleted: false, label: 'Alice' });
  });

  it.each([
    ['invalid_auth', 'credentialInvalid'], ['token_revoked', 'credentialInvalid'], ['missing_scope', 'permissionMissing'],
  ])('maps %s to typed %s on reads and writes', async (error, reason) => {
    const api = createSlackApi({ credentials, http: { async request() { return response({ ok: false, error }); } } });
    await expect(api.getIdentity()).resolves.toMatchObject({ kind: 'notReady', reason });
    await expect(api.postMessage(payload())).resolves.toMatchObject({ kind: 'notReady', reason });
  });

  it('passes provider rate-limit custody without retrying or losing Retry-After', async () => {
    let attempts = 0;
    const api = createSlackApi({ credentials, http: { async request() {
      attempts += 1;
      return response({ ok: false, error: 'ratelimited' }, 429, { 'Retry-After': '17' });
    } } });
    const result = await api.postMessage(payload());
    expect(result).toEqual({ kind: 'notDelivered', retry: 'after', retryAfterMs: 17_000 });
    expect(ConversationDeliveryResultV1Schema.parse(result)).toEqual(result);
    expect(attempts).toBe(1);
    await expect(api.getChannel('C1')).resolves.toMatchObject({ kind: 'notReady', reason: 'rateLimited', retryAfterMs: 17_000 });
  });

  it.each([
    response({ ok: true }), response({ ok: true, channel: 'OTHER', ts: '123.456' }),
    response({ ok: false, error: 'internal_error' }), response({ ok: false, error: 'fatal_error' }),
    response({ ok: false, error: 'service_unavailable' }, 503),
  ])('preserves uncertain sends as outcomeUnknown', async (result) => {
    const api = createSlackApi({ credentials, http: { async request() { return result; } } });
    await expect(api.postMessage(payload())).resolves.toEqual({ kind: 'outcomeUnknown' });
  });

  it('does not retry after a lost send response, and returns accepted IDs only on confirmed success', async () => {
    let attempts = 0;
    const api = createSlackApi({ credentials, http: { async request(input) {
      attempts += 1;
      const body: unknown = JSON.parse(new TextDecoder().decode(input.body));
      expect(body).toEqual(payload());
      if (attempts === 1) throw new Error('Connection lost');
      return response({ ok: true, channel: 'C1', ts: '123.456', message: { text: 'hello' } });
    } } });
    await expect(api.postMessage(payload())).resolves.toEqual({ kind: 'outcomeUnknown' });
    expect(attempts).toBe(1);
    await expect(api.postMessage(payload())).resolves.toEqual({ kind: 'delivered', providerMessageIds: ['123.456'] });
  });

  it('does not claim a complete delivery when Slack reports native truncation', async () => {
    const api = createSlackApi({ credentials, http: { async request() {
      return response({ ok: true, channel: 'C1', ts: '123.456', response_metadata: { warnings: ['message_truncated'] } });
    } } });
    await expect(api.postMessage(payload())).resolves.toEqual({ kind: 'outcomeUnknown', providerMessageIds: ['123.456'] });
  });

  it('keeps archived endpoints distinct from denied posting permission', async () => {
    let error = 'is_archived';
    const api = createSlackApi({ credentials, http: { async request() { return response({ ok: false, error }); } } });
    await expect(api.postMessage(payload())).resolves.toEqual({ kind: 'endpointArchived', recovery: 'ownerMustUnarchiveOrRebind' });
    error = 'not_in_channel';
    await expect(api.postMessage(payload())).resolves.toMatchObject({ kind: 'notReady', reason: 'permissionMissing' });
  });

  it('rejects malformed user authority instead of treating missing bot/deleted facts as a human', async () => {
    const api = createSlackApi({ credentials, http: { async request() {
      return response({ ok: true, user: { id: 'U2', team_id: 'T1', profile: { display_name: 'Alice' } } });
    } } });
    await expect(api.getUser('U2')).resolves.toMatchObject({ kind: 'notReady', reason: 'invalidConfiguration' });
  });

  it('makes no provider effect for already-cancelled sends', async () => {
    const controller = new AbortController();
    controller.abort();
    let attempts = 0;
    const api = createSlackApi({ credentials, http: { async request() { attempts += 1; return response({ ok: true }); } } });
    await expect(api.postMessage(payload(), { signal: controller.signal })).resolves.toEqual({ kind: 'notDelivered', retry: 'safe' });
    expect(attempts).toBe(0);
  });
});
