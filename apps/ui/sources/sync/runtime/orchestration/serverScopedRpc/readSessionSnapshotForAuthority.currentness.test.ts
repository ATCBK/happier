import { afterEach, expect, it } from 'vitest';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { standardCleanup } from '@/dev/testkit';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { captureUiUsageQueryAccountContext } from '@/sync/api/account/usageQueryResource';
import { invalidateAccountEncryptionModeCache, updateAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { createOperationAccountCurrentnessSource } from './fetchSessionByIdWithServerScope';
import { runWithServerRequestAuthorityForServerAccountScope } from './createServerRequestWithServerScope';
import { readSessionSnapshotForAuthority } from './readSessionSnapshotForAuthority';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(async () => { standardCleanup(); retireActiveServerAccountScopeLifetime(); await home?.dispose(); home = undefined; });

it.each(['scope-reset', 'account-encryption-change', 'same-home-resume', 'same-home-mode-setter', 'unknown-home-semantic-change', 'home-identity-promotion'] as const)(
  'reuses one finite scoped observation and admits private reads according to %s invalidation', async (invalidation) => {
  const sessions = createSessionReadBatchHttpBoundary(request => {
      if (request.path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 2 });
      if (/^\/v2\/sessions\/batch-\d+$/.test(request.path)) return Response.json({ session:
        createPlainSessionCurrentProjectionRecordFixture({ id: request.path.split('/').at(-1)! }) });
      const turn = /^\/v1\/sessions\/(batch-\d+)\/turns$/.exec(request.path);
      if (turn) return Response.json({ v: 1, sessionId: turn[1], updatedAt: 1, turns: [] });
      return undefined;
    });
  home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://snapshot-batch-currentness.test', accountId: 'account-a' }],
    route: request => sessions.handle(request) });
  publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
  const { TokenStorage } = await import('@/auth/storage/tokenStorage');
  const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
  const context = captureUiUsageQueryAccountContext(credentials)!;
  const { sync } = await import('@/sync/sync');
  await sync.resumeSync('manual');
  const before = home.httpRequests.filter(request => request.path === '/v1/account/encryption/currentness').length;
  await runWithServerRequestAuthorityForServerAccountScope({ scope: context.accountLifetime.scope, activeRequest: context.request }, async authority => {
    const currentness = createOperationAccountCurrentnessSource({ credentials, request: authority.request,
      serverId: authority.scope.serverId });
    try {
    const rows = await Promise.all(['batch-1', 'batch-2'].map(sessionId => readSessionSnapshotForAuthority({
      authority, sessionId, accountCurrentnessSource: currentness,
    })));
    expect(rows.map(row => row.session.id)).toEqual(['batch-1', 'batch-2']);
    expect(home!.httpRequests.filter(request => request.path === '/v1/account/encryption/currentness')).toHaveLength(before + 1);
    const detailReads = sessions.componentRequests.filter(request => request.path === '/v2/sessions/batch-3').length;
    if (invalidation === 'scope-reset') {
      // Retiring the runtime scope is terminal for its finite observations.
      invalidateAccountEncryptionModeCache({ reason: 'scope-reset' });
    }
    // Mode/key replacement is announced by the existing encryption owner. A
    // completed observation must become unusable, rather than serve stale mode.
    if (invalidation === 'same-home-resume') await sync.resumeSync('manual');
    else if (invalidation === 'same-home-mode-setter') await updateAccountEncryptionMode(credentials, 'plain', { retry: 'none' });
    else if (invalidation === 'unknown-home-semantic-change') invalidateAccountEncryptionModeCache({ serverId: 'unresolvable-home' });
    else if (invalidation === 'home-identity-promotion') {
      // The real feature/adoption owner can learn a portable identity without
      // replacing credentials or the established device-local profile.
      const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
      await setServerProfileIdentityForUrl(home!.homes.a!.serverUrl, 'srv_currentness_promoted');
      invalidateAccountEncryptionModeCache({ serverId: 'srv_currentness_promoted' });
    }
    else if (invalidation !== 'scope-reset') invalidateAccountEncryptionModeCache();
    expect(currentness.isCurrent()).toBe(false);
    await expect(readSessionSnapshotForAuthority({ authority, sessionId: 'batch-3', accountCurrentnessSource: currentness }))
      .rejects.toMatchObject({ code: 'account_encryption_currentness_changed' });
    expect(sessions.componentRequests.filter(request => request.path === '/v2/sessions/batch-3')).toHaveLength(detailReads);
    const currentnessReadsAfterInvalidation = home!.httpRequests.filter(request => request.path === '/v1/account/encryption/currentness').length;
    // Recovery is a new finite observation, through the same strict HTTP owner.
    const replacement = createOperationAccountCurrentnessSource({ credentials, request: authority.request,
      serverId: authority.scope.serverId });
    try {
    expect((await readSessionSnapshotForAuthority({ authority, sessionId: 'batch-3', accountCurrentnessSource: replacement })).session.id)
      .toBe('batch-3');
    expect(home!.httpRequests.filter(request => request.path === '/v1/account/encryption/currentness')).toHaveLength(currentnessReadsAfterInvalidation + 1);
    } finally { replacement.dispose(); }
    } finally { currentness.dispose(); }
  });
});
