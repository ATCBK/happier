import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getActiveServerSnapshot, setActiveServer } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerRuntimeAvailability, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { resolveServerAccountRequestContext, type ResolvedServerAccountRequestContext } from './resolveServerAccountRequestContext';
import { resolveServerScopedContext } from './resolveServerScopedContext';
import { createFakeCryptoWorker } from '@/sync/encryption/nativeCryptoWorker/fakeCryptoWorker';
import { encodeBase64 } from '@/encryption/base64';
import { Encryption } from '@/sync/encryption/encryption';

// The resolver statically reaches the real transport. Install its genuine SDK
// boundary before that import and compile Sync outside a case-local IO budget.
vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

let homes: Awaited<ReturnType<typeof serveAccountHomes>>;
const acquired: ResolvedServerAccountRequestContext[] = [];
const encryptedCredentials = { token: createAccountTokenForTests('encrypted-account'),
  secret: Buffer.from(new Uint8Array(32).fill(7)).toString('base64url') };

beforeEach(async () => {
  homes = await serveAccountHomes({ homes: [
    { key: 'encrypted', serverUrl: 'https://context-encrypted.test', accountId: 'encrypted-account',
      accountMode: 'e2ee', credentials: encryptedCredentials },
    { key: 'plain', serverUrl: 'https://context-plain.test', accountId: 'plain-account' },
    { key: 'focused', serverUrl: 'https://context-focused.test', accountId: 'focused-account',
      serverIdentityId: 'srv_context_focused' },
  ], route: () => undefined });
});

afterEach(async () => {
  for (const context of acquired.splice(0)) if (context.scope === 'scoped') await context.release?.();
  await homes?.dispose();
});

async function resolve(params: Parameters<typeof resolveServerAccountRequestContext>[0]) {
  const context = await resolveServerAccountRequestContext(params);
  acquired.push(context);
  return context;
}

describe('resolveServerAccountRequestContext', () => {
  it('reuses opened material across both scoped readers with recaptured equal credentials', async () => {
    const home = homes.homes.encrypted!;
    const context = await resolve({ serverId: home.id, preferScoped: true });
    if (context.scope !== 'scoped' || !context.encryption) throw new Error('Expected scoped material');
    const worker = createFakeCryptoWorker();
    let openings = 0;
    context.encryption.configureNativeCryptoWorker({ worker: { ...worker,
      decryptDataKeyEnvelopeV1: async request => {
        openings += request.items.length;
        return worker.decryptDataKeyEnvelopeV1(request);
      },
    }, routing: { mode: 'auto', minPayloadBytes: 0 } });
    const key = new Uint8Array(32).fill(47);
    const envelope = encodeBase64(await context.encryption.encryptEncryptionKey(key));
    expect(await context.encryption.decryptEncryptionKey(envelope)).toEqual(key);
    for (let index = 0; index < 8; index += 1) {
      const next = index % 2 === 0
        ? await resolve({ serverId: home.id, preferScoped: true })
        : await resolveServerScopedContext({ serverId: home.id, machineId: 'warm-machine', forceScoped: true });
      try {
        if (next.scope !== 'scoped' || !next.encryption) throw new Error('Expected recaptured scoped material');
        expect(next.credentials).not.toBe(context.credentials);
        // Worker/SDK is the real boundary. Each fresh factory owner would otherwise
        // take the unobserved reference path, so count every actual opening here.
        if (!(next.encryption instanceof Encryption)) throw new Error('Expected canonical Account encryption owner');
        next.encryption.configureNativeCryptoWorker({ worker: { ...worker,
            decryptDataKeyEnvelopeV1: async request => {
              openings += request.items.length;
              return worker.decryptDataKeyEnvelopeV1(request);
            },
          }, routing: { mode: 'auto', minPayloadBytes: 0 } });
        expect(await next.encryption.decryptEncryptionKey(envelope)).toEqual(key);
      } finally { if (next.scope === 'scoped') await next.release?.(); }
    }
    expect(openings).toBe(1);
  });

  it.each(['replacement', 'original mutation', 'original-only mutation', 'sign out', 'plain replacement'] as const)(
    'retires captured scoped material after %s without trusting an equal old recapture', async change => {
      const home = homes.homes.encrypted!;
      const original = await resolve({ serverId: home.id, preferScoped: true });
      if (original.scope !== 'scoped' || !original.encryption || !original.credentials || !('secret' in original.credentials)) {
        throw new Error('Expected exact legacy material');
      }
      const key = new Uint8Array(32).fill(49);
      const envelope = encodeBase64(await original.encryption.encryptEncryptionKey(key));
      expect(await original.encryption.decryptEncryptionKey(envelope)).toEqual(key);
      const captured = original.encryption.getCurrentEncryptionGenerationScope();
      if (change === 'replacement') {
        await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, {
          token: encryptedCredentials.token, secret: Buffer.from(new Uint8Array(32).fill(51)).toString('base64url'),
        });
      } else if (change === 'plain replacement') {
        await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, {
          token: encryptedCredentials.token,
        });
      } else if (change === 'sign out') {
        await TokenStorage.removeCredentialsForServerUrl(home.serverUrl, { serverId: home.id });
      } else {
        // Storage still returns the old bytes. Mutation of the original custody
        // object must nevertheless prevent reviving the retired owner's proof.
        Object.assign(original.credentials, { secret: Buffer.from(new Uint8Array(32).fill(52)).toString('base64url') });
      }
      if (change === 'plain replacement') {
        const next = await resolve({ serverId: home.id, preferScoped: true });
        expect(next.scope === 'scoped' && next.encryption).toBeNull();
      } else if (change !== 'sign out' && change !== 'original-only mutation') {
        const next = await resolve({ serverId: home.id, preferScoped: true });
        if (next.scope !== 'scoped' || !next.encryption) throw new Error('Expected replacement owner');
        expect(await next.encryption.decryptEncryptionKey(envelope)).toEqual(change === 'replacement' ? null : key);
      }
      expect(original.encryption.isCurrentEncryptionGenerationScope(captured)).toBe(false);
      expect(await original.encryption.decryptEncryptionKey(envelope)).toBeNull();
    },
  );

  it('returns the applied active scope when the target is omitted or uses its saved-profile alias', async () => {
    await expect(resolve({})).resolves.toEqual({ scope: 'active', timeoutMs: 30_000 });
    await expect(resolve({ serverId: homes.homes.focused!.profileId })).resolves.toEqual({ scope: 'active', timeoutMs: 30_000 });
  });

  it('retains exact applied and staged Home credentials while the direct runtime is unavailable', async () => {
    const applied = getActiveServerSnapshot();
    publishAppliedActiveServerRuntimeAvailability(false);
    await setActiveServer({ serverId: homes.homes.plain!.id });
    publishAppliedActiveServerSnapshot(applied, false);
    const contexts = await Promise.all([resolve({ serverId: homes.homes.focused!.id }), resolve({ serverId: homes.homes.plain!.id })]);
    expect(contexts.map(context => context.scope === 'scoped' && [context.targetServerId, context.targetAccountId]))
      .toEqual([[homes.homes.focused!.id, 'focused-account'], [homes.homes.plain!.id, 'plain-account']]);
  });

  it('resolves usable encryption from the exact stored credential of another Home', async () => {
    const context = await resolve({ serverId: homes.homes.encrypted!.id, timeoutMs: 5_000 });
    expect(context).toMatchObject({ scope: 'scoped', targetServerId: homes.homes.encrypted!.id,
      targetServerUrl: homes.homes.encrypted!.serverUrl, targetAccountId: 'encrypted-account',
      credentials: encryptedCredentials, timeoutMs: 5_000 });
    if (context.scope !== 'scoped' || !context.encryption) throw new Error('Missing captured Account cipher');
    const value = { private: 'exact Home', bytes: [0, 255] };
    expect(await context.encryption.decryptRaw(await context.encryption.encryptRaw(value))).toEqual(value);
    expect(context.readTransport).toBeDefined();
  });

  it('keeps token-only Plain Accounts keyless without borrowing the focused credential', async () => {
    const context = await resolve({ serverId: homes.homes.plain!.id, timeoutMs: 5_000 });
    expect(context).toMatchObject({ scope: 'scoped', targetServerId: homes.homes.plain!.id,
      targetAccountId: 'plain-account', encryption: null, timeoutMs: 5_000 });
    if (context.scope !== 'scoped') throw new Error('Expected captured Home');
    expect(context.credentials).toEqual({ token: context.token });
    expect(context.runtimeOrigin).toBe(homes.homes.plain!.serverUrl);
  });

  it('refuses a signed-out exact Home instead of substituting focused credentials', async () => {
    expect(await TokenStorage.removeCredentialsForServerUrl(homes.homes.plain!.serverUrl,
      { serverId: homes.homes.plain!.id })).toBe(true);
    await expect(resolve({ serverId: homes.homes.plain!.id })).rejects.toThrow('No authentication credentials');
    expect(await TokenStorage.getCredentialsForServerUrl(homes.homes.focused!.serverUrl,
      { serverId: homes.homes.focused!.id })).not.toBeNull();
  });

  it('can capture the active Home explicitly for a finite caller', async () => {
    const context = await resolve({ preferScoped: true, timeoutMs: 7_000 });
    expect(context).toMatchObject({ scope: 'scoped', timeoutMs: 7_000,
      targetServerId: homes.homes.focused!.id, targetAccountId: 'focused-account' });
  });
});
