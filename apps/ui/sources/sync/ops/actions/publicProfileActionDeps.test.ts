import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublicProfileOwnerReadV1Schema, DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1 } from '@happier-dev/protocol/account/publicProfile';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { standardCleanup } from '@/dev/testkit';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createDefaultActionExecutor } from './defaultActionExecutor';

const machineRpc = vi.hoisted(() => vi.fn());
// The Machine RPC is the external boundary; preparation and Action admission stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(async () => { machineRpc.mockReset(); standardCleanup(); retireActiveServerAccountScopeLifetime(); await home?.dispose(); home = undefined; });

describe('public-profile UI captured Account binding', () => {
  it.each(['off', 'default'] as const)('honors SCM Action %s while preparing selected public projects', async setting => {
    const policy = { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, projects: true } };
    const owner = PublicProfileOwnerReadV1Schema.parse({ kind: 'ready', context: { handle: 'ada', identity: {}, service: null, urls: null },
      record: { state: 'published', policy, metadata: {}, projectSelections: [], query: normalizeUsageQuery({}), snapshot: null,
        layout: { v: 1, items: [] }, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
        updatedAtMs: 1, publishedAtMs: 1, restriction: null } });
    machineRpc.mockResolvedValue({ success: true, kind: 'public', repository: { label: 'team/repo', url: 'https://forge.test/team/repo' } });
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://profile-home.test', accountId: 'account-a',
      settings: { actionsSettingsV1: { v: 1, actions: setting === 'off'
        ? { 'scm.hostingRepository.get': { disabledSurfaces: ['ui'] } } : {} } } }],
      route: request => {
        if (request.path === '/v1/account/public-profile' && request.method === 'GET') return Response.json(owner);
        if (request.path === '/v1/account/public-profile/policy' && request.method === 'PUT') {
          return Response.json({ kind: 'updated', record: owner.kind === 'ready' ? owner.record : null });
        }
        return undefined;
      } });
    const focused = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: focused.id, serverUrl: focused.serverUrl, generation: 0 });
    const result = await createDefaultActionExecutor().execute('account.public_profile.update', { metadataSelection: {
      projectSelections: [{ provider: { id: 'example/forge', kind: 'custom', displayName: 'Forge', baseUrl: 'https://forge.test' },
        repository: { nameWithOwner: 'team/repo' }, protocol: 'https' }],
    } }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: focused.id,
      expectedAccountId: 'account-a', defaultSessionMachineId: 'machine' });
    const write = home.requests.find(request => request.path === '/v1/account/public-profile/policy' && request.method === 'PUT');
    if (setting === 'off') {
      expect(result).toMatchObject({ ok: false, errorCode: 'public_profile_preparation_unavailable' });
      expect(machineRpc).not.toHaveBeenCalled();
      expect(write).toBeUndefined();
    } else {
      expect(result).toMatchObject({ ok: true, result: { kind: 'updated' } });
      expect(machineRpc).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine', serverId: focused.id, accountId: 'account-a',
        method: 'scm.hostingRepository.get' }));
      expect(write?.body).toMatchObject({ metadata: { projects: [{ label: 'team/repo', url: 'https://forge.test/team/repo' }] } });
    }
  });
  it('uses the shared layout-only preparer and keeps private Usage unread', async () => {
    const layout = { v: 1, items: [] } as const;
    const owner = PublicProfileOwnerReadV1Schema.parse({ kind: 'ready', context: { handle: 'ada', identity: {},
      service: null, urls: null }, record: { state: 'published', policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1,
      metadata: {}, projectSelections: [], query: normalizeUsageQuery({}), snapshot: null, layout,
      appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, updatedAtMs: 1, publishedAtMs: 1, restriction: null,
    } });
    const applied: unknown[] = [];
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://profile-home.test', accountId: 'account-a' }],
      route: request => {
        if (request.path === '/v1/account/public-profile' && request.method === 'GET') return Response.json(owner);
        if (request.path === '/v1/account/public-profile/policy' && request.method === 'PUT') {
          applied.push(request.body);
          return Response.json({ kind: 'updated', record: owner.kind === 'ready' ? owner.record : null });
        }
        return undefined;
      } });
    const focused = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: focused.id, serverUrl: focused.serverUrl, generation: 0 });
    await expect(createDefaultActionExecutor().execute('account.public_profile.update', { layout }, {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: focused.id, expectedAccountId: 'account-a',
    })).resolves.toMatchObject({ ok: true, result: { kind: 'updated', refresh: 'not_needed' } });
    expect(applied).toEqual([{ layout }]);
    expect(home.requests.some(request => request.path === '/v2/usage/query')).toBe(false);
  });
});
