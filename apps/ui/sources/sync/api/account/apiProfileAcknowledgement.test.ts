import { beforeAll, expect, it } from 'vitest';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { PROFILE_RECORDS_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileRecordV1';

installDisconnectedServerSocketBoundary();
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { deleteProfileRecordInContext } = await import('./apiProfileCatalog');
beforeAll(loadSyncSingletonForTests);

it('settles a Profile cleanup transaction without waiting for the Settings projection reread', async () => {
    let committed = false;
    let rereadStarted = false;
    let releaseRead!: () => void;
    const heldRead = new Promise<void>(resolve => { releaseRead = resolve; });
    const account = await restoreServerAccountForTest({ serverUrl: 'https://profile-cleanup-ack.example.test', accountId: 'profile-cleanup-ack',
        request: async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health') return Response.json({});
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: committed ? 8 : 7 }));
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === '/v2/account/settings') {
                if (committed) { rereadStarted = true; await heldRead; }
                return Response.json({ version: committed ? 8 : 7, content: { t: 'plain', v: { favoriteProfiles: committed ? [] : ['removed-profile'] } } });
            }
            if (path === PROFILE_RECORDS_ROUTE_V1 && init?.method === 'POST') {
                committed = true;
                return Response.json({ status: 'updated', revision: 5, cursor: 5, referenceGuardRevision: 5 });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        } });
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const context = await captureLazyActionAccountContext(account.home.id);
    getStorage().setState({ settingsScope: context.accountLifetime.scope });
    let result: unknown;
    const writing = deleteProfileRecordInContext(context, { id: 'removed-profile', expectedRevision: 4,
        previousDefinition: { kind: 'artifact', artifactId: 'definition' } }).then(receipt => { result = receipt; });
    try {
        await expect.poll(() => rereadStarted).toBe(true);
        expect(result).toMatchObject({ status: 'updated', revision: 5 });
    } finally {
        releaseRead();
        await writing;
        context.dispose();
        await account.dispose();
    }
});
