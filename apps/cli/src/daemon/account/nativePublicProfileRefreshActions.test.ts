import { afterEach, describe, expect, it } from 'vitest';

import { createNativePublicProfileRefreshFixture } from './publicProfileRefresh.testkit';

describe('native public-profile Account Action adapter', () => {
  const fixtures: Awaited<ReturnType<typeof createNativePublicProfileRefreshFixture>>[] = [];
  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await fixture.dispose();
  });
  const context = () => ({ surface: 'cli' as const, signal: new AbortController().signal });
  async function fixture(settings: unknown) {
    const account = await createNativePublicProfileRefreshFixture({ computedAtMs: null, settings });
    fixtures.push(account);
    return account;
  }

  it.each([
    { policy: { v: 1 }, code: 'approval_required' },
    { policy: { v: 1, approvalWaivedSurfaces: { 'account.public_profile.refresh': ['ui', 'agent'] } }, code: 'approval_required' },
    { policy: { v: 1, actions: { 'account.public_profile.refresh': { enabled: false } } }, code: 'action_disabled' },
    { policy: { v: 1, approvalWaivedSurfaces: { 'account.public_profile.refresh': ['cli'] },
      actions: { 'account.public_profile.refresh': { approvalRequiredSurfaces: ['cli'] } } }, code: 'approval_required' },
  ])('refuses $code through canonical CLI policy before any background preparation', async ({ policy, code }) => {
    const f = await fixture(policy);
    await expect(f.actions.refresh(context())).resolves.toMatchObject({ ok: false, errorCode: code });
    expect(f.requests).toEqual([]);
  });

  it('runs Allowed CLI refresh through real Usage computation and acknowledges only the facts-only HTTP snapshot effect', async () => {
    const f = await fixture({ v: 1, approvalWaivedSurfaces: { 'account.public_profile.refresh': ['cli'] } });
    await expect(f.actions.refresh(context())).resolves.toMatchObject({ ok: true,
      result: { kind: 'updated', record: { state: 'published', snapshot: { facts: { tokens: 10 } } } } });
    expect(f.refreshes).toHaveLength(1);
    expect(Object.keys(f.refreshes[0]!).sort()).toEqual(['query', 'snapshot']);
    expect(f.requests.filter(request => request.method !== 'GET' && request.path !== '/v2/usage/query')).toEqual([
      { method: 'PUT', path: '/v1/account/public-profile/snapshot' },
    ]);
  });

  it('returns the shared typed refusal when the real Usage HTTP source is unavailable', async () => {
    const f = await fixture({ v: 1, approvalWaivedSurfaces: { 'account.public_profile.refresh': ['cli'] } });
    f.setUsageAvailable(false);
    await expect(f.actions.refresh(context())).resolves.toMatchObject({ ok: false,
      errorCode: 'public_profile_preparation_unavailable', details: { reason: 'usage_unavailable' } });
    expect(f.refreshes).toEqual([]);
  });
});
