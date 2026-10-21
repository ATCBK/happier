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

  it('runs Allowed CLI refresh through the captured Account binding and refuses the missing shared snapshot producer', async () => {
    const f = await fixture({ v: 1, approvalWaivedSurfaces: { 'account.public_profile.refresh': ['cli'] } });
    await expect(f.actions.refresh(context())).resolves.toMatchObject({ ok: false,
      errorCode: 'public_profile_preparation_unavailable', details: { reason: 'usage_unavailable' } });
    expect(f.requests).toEqual([{ method: 'GET', path: '/v1/account/public-profile' }]);
  });
});
