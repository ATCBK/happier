import * as React from 'react';
import { afterEach, expect, it } from 'vitest';

import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { invalidateUsageQueryResources } from '@/sync/api/account/usageQueryResource';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { storage } from '@/sync/domains/state/storage';
import { t } from '@/text';

import AgentInputResetStartPicker from './AgentInputResetStartPicker';

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(async () => {
    standardCleanup();
    retireActiveServerAccountScopeLifetime();
    invalidateUsageQueryResources();
    await home?.dispose();
    home = undefined;
});

it('settles the reset picker from quota demand without reading Session accounting', async () => {
    let accountingReads = 0;
    home = await serveAccountHomes({
        homes: [{ key: 'home', serverUrl: 'https://reset-picker.test', accountId: 'alice' }],
        route: request => {
            if (request.path === '/v2/usage/query') {
                accountingReads += 1;
                return Response.json({ v: 1, totals: { eventCount: 0,
                    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                    cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } } });
            }
            if (request.path === '/v1/account/encryption/currentness') {
                return Response.json({ mode: 'plain', version: 1, signingKeyFingerprint: null,
                    contentKeyFingerprint: null, updatedAt: 1 });
            }
            return undefined;
        },
    });
    const target = home.homes.home!;
    publishAppliedActiveServerSnapshot({ serverId: target.id, serverUrl: target.serverUrl, generation: 0 });
    storage.setState({ profileScope: { serverId: target.id, accountId: 'alice' },
        profile: AccountProfileSchema.parse({ id: 'alice' }) });
    const credentials = await TokenStorage.getCredentialsForServerUrl(target.serverUrl);
    const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
        <AgentInputResetStartPicker sessionId="session-a" serverId={target.id} onSelect={() => {}} />
    </InjectedAuthProvider>);
    await expect.poll(() => screen.findAllByType(SurfaceStateCard).some(card => card.props.kind === 'unavailable'
        && card.props.reason === t('usage.board.plans.resetStartNoReset'))).toBe(true);
    expect(accountingReads).toBe(0);
});
