import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getActiveServerSnapshot, setActiveServer } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerRuntimeAvailability, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { resolveServerAccountRequestContext, type ResolvedServerAccountRequestContext } from './resolveServerAccountRequestContext';

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
