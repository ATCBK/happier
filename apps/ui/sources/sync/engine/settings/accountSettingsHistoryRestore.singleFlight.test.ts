import { describe, expect, it } from 'vitest';

import { createDeferred } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { encodeBase64 } from '@/encryption/base64';
import { normalizeAccountSettingsHistoryAfterTransfer } from './accountSettingsHistoryRestore';

describe('Account Settings history maintenance requests', () => {
    it.each([
        { accountMode: 'plain' as const, differentProof: false },
        { accountMode: 'e2ee' as const, differentProof: false },
        { accountMode: 'e2ee' as const, differentProof: true },
    ])('shares equivalent $accountMode cleanup and scans again only when its inputs change (different proof: $differentProof)', async ({ accountMode, differentProof }) => {
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        let detailReads = 0;
        let settingsVersion = 7;
        let accountVersion = 1;
        let transferRevision: number | null = null;
        let privateRevision: number | null = null;
        let detailUnavailable = false;
        let recoveryRevision = 1;
        const home = await serveAccountHomes({
            homes: [{ key: 'home', serverUrl: 'https://history-maintenance.test', accountId: 'alice', accountMode,
                credentials: { token: createAccountTokenForTests('alice'), secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') },
                encryptionCurrentness: () => ({
                    mode: accountMode, version: accountVersion, settingsVersion,
                    signingKeyFingerprint: accountMode === 'plain' ? null : 'signing',
                    contentKeyFingerprint: accountMode === 'plain' ? null : 'content', updatedAt: 1,
                }),
            }],
            route: async request => {
                if (request.path === '/v1/account/entity-rows/profiles/transfer') return Response.json(transferRevision === null
                    ? { status: 'absent' } : { status: 'deleted', revision: transferRevision });
                if (request.path === '/v1/account/entity-rows/mcp') return Response.json(privateRevision === null
                    ? { status: 'absent' } : { status: 'deleted', revision: privateRevision });
                if (request.path === '/v2/account/settings/history') return Response.json({ snapshots: [{
                    version: 6, createdAt: '2026-01-01T00:00:00.000Z', contentKind: 'plain', byteLength: 100,
                }] });
                if (request.path === '/v2/account/settings/history/6') {
                    detailReads += 1;
                    entered.resolve();
                    await release.promise;
                    if (detailUnavailable) return Response.json({ error: 'unavailable' }, { status: 503 });
                    return Response.json({ version: 6, createdAt: '2026-01-01T00:00:00.000Z',
                        content: { t: 'plain', v: { preferredLanguage: 'de' } } });
                }
                return undefined;
            },
        });
        const contexts = await Promise.all([
            captureLazyActionAccountContext(home.homes.home!.id),
            captureLazyActionAccountContext(home.homes.home!.id),
        ]);
        try {
            const encryptions = await Promise.all(contexts.map(context => context.resolveAccountEncryption()));
            const scan = (index: number, roots: string[]) => {
                const context = contexts[index]!;
                return normalizeAccountSettingsHistoryAfterTransfer({
                    credentials: context.credentials, encryption: encryptions[index]!.encryption,
                    settingsScope: { serverId: context.serverId, accountId: context.accountId },
                    destinationAuthority: { activeTransferredRoots: roots,
                        ...(differentProof && index === 1 ? { savedSecretTransfers: [{ savedSecretId: 'old', resourceId: 'resource', expectedRevision: 1 }] } : {}) },
                    savedSecretRecovery: { accountId: context.accountId, source: { version: 7, raw: { preferredLanguage: 'de' } },
                        resources: [{ resourceId: 'resource', ownerAccountId: context.accountId, revision: recoveryRevision, materialStatus: 'ready' }] },
                    requestContext: { request: context.request, isCurrent: context.accountLifetime.isCurrent },
                });
            };
            const first = scan(0, ['profiles']);
            await entered.promise;
            const second = scan(1, ['mcpServers']);
            release.resolve();
            expect(await Promise.all([first, second])).toEqual([{ status: 'complete' }, { status: 'complete' }]);
            expect(detailReads).toBe(differentProof ? 2 : 1);
            accountVersion++;
            expect(await scan(1, ['profiles'])).toEqual({ status: 'complete' });
            expect(detailReads).toBe(differentProof ? 2 : 1);
            settingsVersion++;
            expect(await scan(1, ['profiles'])).toEqual({ status: 'complete' });
            expect(detailReads).toBe(differentProof ? 3 : 2);
            transferRevision = 1;
            expect(await scan(1, ['profiles'])).toEqual({ status: 'complete' });
            expect(detailReads).toBe(differentProof ? 4 : 3);
            privateRevision = 1;
            expect(await scan(1, ['profiles'])).toEqual({ status: 'complete' });
            expect(detailReads).toBe(differentProof ? 5 : 4);
            settingsVersion++;
            detailUnavailable = true;
            expect(await scan(1, ['profiles'])).toEqual({ status: 'cleanup-pending', versions: [6] });
            detailUnavailable = false;
            expect(await scan(1, ['profiles'])).toEqual({ status: 'complete' });
            expect(detailReads).toBe(differentProof ? 7 : 6);
            recoveryRevision++;
            expect(await scan(1, ['profiles'])).toEqual({ status: 'complete' });
            expect(detailReads).toBe(differentProof ? 8 : 7);
        } finally {
            release.resolve();
            contexts.forEach(context => context.dispose());
            await home.dispose();
        }
    });
});
