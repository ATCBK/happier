import { expect, it } from 'vitest';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';

installDisconnectedServerSocketBoundary();
const { refreshAcpCatalog, resetAcpCatalogEngineForTests } = await import('@/sync/engine/settings/acpCatalogEngine');
const { getAcpCatalogSnapshot, resetAcpCatalogSnapshotsForTests } = await import('@/sync/store/settings/acpCatalogSnapshot');
const { readAcpCatalog, writeAcpCatalogRecordInContext } = await import('./apiAcpCatalog');

it.each(['same-row', 'newer-ack'] as const)('resumes pending ACP activation cleanup on demand without holding foreground reads (%s)', async state => {
    let active = false;
    let revision = 0;
    let historyReads = 0;
    let holdHistory = false;
    let releaseHistory!: () => void;
    const held = new Promise<void>(resolve => { releaseHistory = resolve; });
    const record = { v: 1 as const, definitions: [] };
    const account = await restoreServerAccountForTest({ serverUrl: `https://acp-maintenance-${state}.example.test`, accountId: `acp-maintenance-${state}`,
        request: async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health') return Response.json({});
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: active ? 8 : 7 }));
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === '/v1/account/entity-rows/profiles/transfer') return Response.json({ status: 'absent' });
            if (path === '/v2/account/settings') return Response.json({ version: active ? 8 : 7, content: { t: 'plain', v:
                active ? {} : { acpCatalogSettingsV1: { v: 2, backends: [] } } } });
            if (path === '/v1/account/entity-rows/acp') {
                if (init?.method === 'POST') { if (active) revision += 1; active = true; return Response.json({ status: 'updated', revision, cursor: revision + 1 }); }
                return Response.json(active ? { status: 'present', revision, content: { t: 'plain', v: record } } : { status: 'absent' });
            }
            if (path === '/v2/account/settings/history') {
                historyReads += 1;
                if (holdHistory) { await held; return Response.json({ snapshots: [] }); }
                return Response.json({ error: 'unreachable' }, { status: 503 });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        } });
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const context = await captureLazyActionAccountContext(account.home.id);
    let foreground: Promise<void> | undefined;
    try {
        expect(await writeAcpCatalogRecordInContext(context, { record: { v: 1, definitions: [] }, expectedRevision: 'absent',
            sourceSettingsVersion: 7 })).toMatchObject({ status: 'updated', cleanup: { status: 'cleanup-pending' } });
        const activationReads = historyReads;
        expect(activationReads).toBeGreaterThan(0);
        holdHistory = true;
        let settled = false;
        foreground = refreshAcpCatalog(context.accountLifetime.scope).then(() => { settled = true; });
        await expect.poll(() => historyReads).toBe(activationReads + 1);
        expect(settled).toBe(true);
        expect(getAcpCatalogSnapshot(context.accountLifetime.scope)).toMatchObject({ stale: false, catalog: { status: 'ready', revision: 0 } });
        await refreshAcpCatalog(context.accountLifetime.scope);
        expect(historyReads).toBe(activationReads + 1);
        if (state === 'newer-ack') {
            expect(await writeAcpCatalogRecordInContext(context, { record, expectedRevision: 0 })).toMatchObject({ status: 'updated', revision: 1 });
            // Await the public maintenance completion path, not a timer or internal loader state.
            const completed = readAcpCatalog(context.accountLifetime.scope, undefined, { onReady: () => {}, hasPendingCleanup: () => false });
            releaseHistory();
            await completed;
            expect(getAcpCatalogSnapshot(context.accountLifetime.scope)).toMatchObject({ revision: 1, stale: true, catalog: { status: 'loading' } });
            expect(getAcpCatalogSnapshot(context.accountLifetime.scope)?.cleanup).toBeUndefined();
            return;
        }
        releaseHistory();
        await expect.poll(() => getAcpCatalogSnapshot(context.accountLifetime.scope)?.cleanup?.status).toBe('complete');
    } finally {
        releaseHistory();
        await foreground;
        context.dispose();
        resetAcpCatalogEngineForTests();
        resetAcpCatalogSnapshotsForTests();
        await account.dispose();
    }
});
