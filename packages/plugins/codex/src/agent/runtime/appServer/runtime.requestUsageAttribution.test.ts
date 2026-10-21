import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { buildConnectedServiceCredentialRecord, StrictJsonValueSchema } from '@happier-dev/protocol';
import type { AgentSessionOpenRequest, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';

import { createCodexNativeAppServerRuntimeHost } from './native.js';
import type { CodexAppServerEvent } from './core.js';
import { waitForCodexAppServerRuntimeTurnCompletion } from './runtime.js';
import { withCodexNativeAttachFixture } from './runtime.nativeAttach.test-support.js';

// Only the native process/socket and host auth service are substituted. The
// native host refresh adapter, JSON-RPC client, runtime and usage codec are real.
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, userInfo: () => ({ ...actual.userInfo(), homedir: process.env.TMPDIR || actual.userInfo().homedir }) };
});

const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
const credentialRevision = 'csr_0123456789ABCDEFGHJKMNPQRS';
const credential = (profileId: string) => StrictJsonValueSchema.parse(buildConnectedServiceCredentialRecord({
  now: 1000, serviceId: service.localId, profileId, kind: 'oauth', expiresAt: 2000,
  oauth: { accessToken: `synthetic-${profileId}`, refreshToken: 'synthetic-refresh', idToken: null,
    scope: null, tokenType: null, providerAccountId: profileId, providerEmail: null },
}));

function nativeRequest(socket: WebSocket, method: string, params: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = 'fixture-refresh';
    const receive = (payload: Buffer) => {
      const message = JSON.parse(payload.toString()) as { id?: unknown; result?: unknown; error?: unknown };
      if (message.id !== id) return;
      socket.off('message', receive);
      if (message.error) reject(new Error('Native request failed'));
      else resolve(message.result);
    };
    socket.on('message', receive);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

describe('prospective native request account scope', () => {
  it('does not echo A plan onto B refresh and qualifies only the next fresh B request', async () => {
    const context = {
      signal: new AbortController().signal,
      services: { sessions: { current: null }, logger: { debug() {}, warn() {} } },
      session: { id: 'actual-happier-session', services: { auth: { services: {
        refreshRuntimeAuth: async () => ({ status: 'refreshed', result: {
          credentialRevision, accessToken: 'synthetic-B', providerAccountId: 'account-B',
        } }),
      } } } },
    } as unknown as AgentSessionRuntimeContext;
    const host = createCodexNativeAppServerRuntimeHost({ request: { sessionId: context.session.id } as AgentSessionOpenRequest,
      context, processEnv: {} });
    await expect(host.refreshRuntimeAuth?.({ serviceId: service.localId, reason: 'credential_expired', planType: 'plus' }))
      .resolves.toMatchObject({ status: 'refreshed', result: { chatgptAccountId: 'account-B', chatgptPlanType: null } });
    let planType = 'plus';
    let socket: WebSocket | undefined;
    await withCodexNativeAttachFixture(async ({ runtime, emitNotification, requests }) => {
      const events: CodexAppServerEvent[] = [];
      runtime.events.subscribe(event => events.push(event));
      const apply = (profileId: string) => runtime.runtimeAuth.apply({ serviceId: service.localId,
        authGeneration: { credential: credential(profileId), credentialRevision,
          forcedWorkspaceId: profileId, selection: { kind: 'profile', serviceId: service.localId, profileId } } });
      const usage = async (nativeTurnId: string) => {
        const before = events.filter(event => event.kind === 'usage-observed').length;
        emitNotification('thread/tokenUsage/updated', { threadId: 'fresh-thread', turnId: nativeTurnId,
          tokenUsage: { last: { totalTokens: 3, inputTokens: 2, outputTokens: 1 } } });
        await expect.poll(() => events.filter(event => event.kind === 'usage-observed').length).toBe(before + 1);
        return events.filter(event => event.kind === 'usage-observed').at(-1);
      };
      expect(await apply('account-A')).toMatchObject({ ok: true });
      await runtime.send({ v: 1, text: 'first' }, { turnId: 'host-first' });
      expect(await usage('provider-turn-1')).toMatchObject({ attribution: { source: {
        kind: 'native', accountScope: 'personal', connectedAccount: { service, accountId: 'account-A' },
      } } });
      expect(socket).toBeDefined();
      const refreshed = await nativeRequest(socket!, 'account/chatgptAuthTokens/refresh', { chatgptPlanType: 'plus' });
      expect(refreshed).toMatchObject({ accessToken: 'synthetic-B', chatgptAccountId: 'account-B' });
      expect(refreshed).not.toHaveProperty('chatgptPlanType');
      planType = 'team';
      expect(await usage('provider-turn-1')).not.toHaveProperty('attribution');
      const completed = waitForCodexAppServerRuntimeTurnCompletion(runtime);
      emitNotification('turn/completed', { threadId: 'fresh-thread', turn: { id: 'provider-turn-1', status: 'completed' } });
      await completed;
      expect(await apply('account-B')).toMatchObject({ ok: true });
      await runtime.send({ v: 1, text: 'fresh' }, { turnId: 'host-next' });
      expect(await usage('provider-turn-2')).toMatchObject({ attribution: { source: {
        kind: 'native', accountScope: 'workspace', connectedAccount: { service, accountId: 'account-B' },
      } } });
      expect(requests.filter(request => request.method === 'account/login/start')
        .every(request => !Object.hasOwn(request.params, 'chatgptPlanType'))).toBe(true);
    }, { connectedAccountService: service,
      runtimeAuthHost: { refreshRuntimeAuth: host.refreshRuntimeAuth },
      accountRead: () => ({ account: { type: 'chatgpt', email: null, planType } }),
      onTurnStart: input => { socket = input.socket; },
    });
  });

  it.each(['missing', 'unrecognized', 'failed'] as const)('leaves %s native plan evidence unknown', async kind => {
    await withCodexNativeAttachFixture(async ({ runtime, emitNotification }) => {
      const events: CodexAppServerEvent[] = [];
      runtime.events.subscribe(event => events.push(event));
      expect(await runtime.runtimeAuth.apply({ serviceId: service.localId, authGeneration: {
        credential: credential('account-A'), credentialRevision, forcedWorkspaceId: 'account-A',
        selection: { kind: 'profile', serviceId: service.localId, profileId: 'account-A' },
      } })).toMatchObject({ ok: true });
      await runtime.send({ v: 1, text: 'unknown plan' }, { turnId: 'host-turn' });
      emitNotification('thread/tokenUsage/updated', { threadId: 'fresh-thread', turnId: 'provider-turn-1',
        tokenUsage: { last: { totalTokens: 3, inputTokens: 2, outputTokens: 1 } } });
      await expect.poll(() => events.filter(event => event.kind === 'usage-observed').length).toBe(1);
      const event = events.find(event => event.kind === 'usage-observed');
      expect(event).toMatchObject({ attribution: { source: { kind: 'native', connectedAccount: { accountId: 'account-A' } } } });
      if (event?.kind !== 'usage-observed') throw new Error('Expected usage');
      expect(event.attribution?.source).not.toHaveProperty('accountScope');
    }, { connectedAccountService: service, runtimeAuthHost: { refreshRuntimeAuth: async () => ({ status: 'failed', reason: 'unused' }) }, accountRead: () => {
      if (kind === 'failed') throw new Error('Synthetic transport failure');
      return { account: { type: 'chatgpt', ...(kind === 'unrecognized' ? { planType: 'future-plan' } : {}) } };
    } });
  });

  it.each(['accepted', 'failed'] as const)('does not restore scope when an auth apply is %s during the plan read', async outcome => {
    let releaseRead!: (value: unknown) => void;
    let notifyRead!: () => void;
    const reading = new Promise<void>(resolve => { notifyRead = resolve; });
    const delayedRead = new Promise<unknown>(resolve => { releaseRead = resolve; });
    let blockRead = false;
    await withCodexNativeAttachFixture(async ({ runtime, emitNotification }) => {
      const events: CodexAppServerEvent[] = [];
      runtime.events.subscribe(event => events.push(event));
      const apply = (profileId: string) => runtime.runtimeAuth.apply({ serviceId: service.localId, authGeneration: {
        credential: credential(profileId), credentialRevision, forcedWorkspaceId: profileId,
        selection: { kind: 'profile', serviceId: service.localId, profileId },
      } });
      expect(await apply('account-A')).toMatchObject({ ok: true });
      blockRead = true;
      const sending = runtime.send({ v: 1, text: 'auth changes during read' }, { turnId: 'host-turn' });
      await reading;
      if (outcome === 'accepted') expect(await apply('account-B')).toMatchObject({ ok: true });
      else expect(await runtime.runtimeAuth.apply({ serviceId: service.localId })).toMatchObject({ ok: false });
      releaseRead({ account: { type: 'chatgpt', planType: 'plus' } });
      await sending;
      emitNotification('thread/tokenUsage/updated', { threadId: 'fresh-thread', turnId: 'provider-turn-1',
        tokenUsage: { last: { totalTokens: 3, inputTokens: 2, outputTokens: 1 } } });
      await expect.poll(() => events.filter(event => event.kind === 'usage-observed').length).toBe(1);
      expect(events.find(event => event.kind === 'usage-observed')).not.toHaveProperty('attribution');
    }, { connectedAccountService: service,
      runtimeAuthHost: { refreshRuntimeAuth: async () => ({ status: 'failed', reason: 'unused' }) },
      accountRead: async () => {
        if (!blockRead) return { account: { type: 'chatgpt', planType: 'plus' } };
        blockRead = false;
        notifyRead();
        return await delayedRead;
      },
    });
  });
});
