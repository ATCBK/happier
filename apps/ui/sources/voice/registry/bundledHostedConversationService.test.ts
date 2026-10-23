import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit';
import {
  installDisconnectedServerSocketBoundary,
  restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';

vi.mock('socket.io-client', async (importOriginal) => (
  await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();

import { createBundledHostedConversationService } from './bundledConversationRuntimeHost';

describe('createBundledHostedConversationService', () => {
  const requests: Array<{ path: string; body: unknown; authorization: string | null }> = [];
  let account: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
  let admissionStarted: boolean;
  let holdAdmission: boolean;
  let observedAbort: boolean;
  let admissionEntered = createDeferred<void>();

  beforeEach(async () => {
    requests.length = 0;
    admissionStarted = false;
    admissionEntered = createDeferred<void>();
    holdAdmission = false;
    observedAbort = false;
    account = await restoreServerAccountForTest({
      serverUrl: 'https://hosted-service.example.test',
      accountId: 'hosted-account',
      credentialScope: 'restored-home',
      request: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/health') return new Response('{}');
        if (!path.startsWith('/v1/voice/')) return null;
        requests.push({ path, body: JSON.parse(String(init?.body)), authorization: new Headers(init?.headers).get('Authorization') });
        if (path === '/v1/voice/token') {
          admissionStarted = true;
          admissionEntered.resolve();
          if (holdAdmission) {
            await new Promise<void>((resolve) => init?.signal?.addEventListener('abort', () => {
              observedAbort = init.signal?.aborted === true;
              resolve();
            }, { once: true }));
            throw Object.assign(new Error('aborted'), { code: 'aborted' });
          }
          return Response.json({ allowed: true, token: 'provider-token', leaseId: 'lease-1', bindingNonce: 'nonce-1', expiresAtMs: 12_000 });
        }
        if (path === '/v1/voice/session/complete' || path === '/v1/voice/session/release') return Response.json({ ok: true });
        throw new Error(`Unexpected hosted request: ${path}`);
      },
    });
  });

  afterEach(async () => {
    await account?.dispose();
    vi.restoreAllMocks();
  });

  it('binds the minted lease to one attempt and completes through the canonical API', async () => {
    const service = createBundledHostedConversationService({
      signal: new AbortController().signal,
      isCurrent: () => true,
    });

    await expect(service.start({ sessionId: 'session-1' })).resolves.toEqual({
      allowed: true,
      token: 'provider-token',
      leaseId: 'lease-1',
      bindingNonce: 'nonce-1',
      expiresAtMs: 12_000,
    });
    await service.complete({ providerConversationId: 'provider-conversation-1' });
    await service.complete({ providerConversationId: 'ignored-second-completion' });

    expect(requests).toEqual([
      { path: '/v1/voice/token', body: { sessionId: 'session-1' }, authorization: `Bearer ${account.credentials.token}` },
      { path: '/v1/voice/session/complete', body: { leaseId: 'lease-1', providerConversationId: 'provider-conversation-1' }, authorization: `Bearer ${account.credentials.token}` },
    ]);
  });

  it('aborts in-flight admission without creating a second server settlement writer', async () => {
    holdAdmission = true;
    const service = createBundledHostedConversationService({
      signal: new AbortController().signal,
      isCurrent: () => true,
    });

    const start = service.start({ sessionId: null });
    await admissionEntered.promise;
    expect(admissionStarted).toBe(true);
    await service.abort();
    await expect(start).rejects.toMatchObject({ code: 'aborted' });

    expect(observedAbort).toBe(true);
    expect(requests).toEqual([{ path: '/v1/voice/token', body: {}, authorization: `Bearer ${account.credentials.token}` }]);
  });

  it('releases a minted lease when the attempt aborts before completion', async () => {
    const service = createBundledHostedConversationService({
      signal: new AbortController().signal,
      isCurrent: () => true,
    });

    await service.start({ sessionId: 'session-1' });
    await service.abort();
    await service.abort();

    expect(requests).toEqual([
      { path: '/v1/voice/token', body: { sessionId: 'session-1' }, authorization: `Bearer ${account.credentials.token}` },
      { path: '/v1/voice/session/release', body: { leaseId: 'lease-1' }, authorization: `Bearer ${account.credentials.token}` },
    ]);
  });

  it('rejects admission after the owning Voice generation is revoked', async () => {
    const service = createBundledHostedConversationService({
      signal: new AbortController().signal,
      isCurrent: () => false,
    });

    await expect(service.start({ sessionId: null })).rejects.toMatchObject({
      code: 'hosted_conversation_generation_revoked',
    });
    expect(requests).toEqual([]);
  });
});
