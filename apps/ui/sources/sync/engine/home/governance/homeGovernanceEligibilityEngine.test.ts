import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeGovernanceEligibilityV1Schema } from '@happier-dev/protocol/home/governance/projection';

const runtimeFetchMock = vi.hoisted(() => vi.fn());
const getCredentialsForServerUrlMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({
    runtimeFetchWithServerReachability: runtimeFetchMock,
}));

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({
        importOriginal,
        tokenStorage: { getCredentialsForServerUrl: getCredentialsForServerUrlMock },
    });
});

import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import {
    getHomeGovernanceEligibilitySnapshot,
    resetHomeGovernanceEligibilitySnapshotsForTests,
} from '@/sync/store/home/governance/homeGovernanceEligibilitySnapshots';

import {
    observeHomeGovernanceEligibility,
    refreshHomeGovernanceEligibility,
    resetHomeGovernanceEligibilityEngineForTests,
} from './homeGovernanceEligibilityEngine';

function tokenForSub(sub: string): string {
    const payload = globalThis.btoa(JSON.stringify({ sub }))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
    return `e30.${payload}.signature`;
}

function response(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
    runtimeFetchMock.mockReset();
    getCredentialsForServerUrlMock.mockReset();
    getCredentialsForServerUrlMock.mockResolvedValue({ token: tokenForSub('member-a') });
    resetHomeGovernanceEligibilitySnapshotsForTests();
    resetHomeGovernanceEligibilityEngineForTests();
});

afterEach(() => {
    resetHomeGovernanceEligibilityEngineForTests();
    resetHomeGovernanceEligibilitySnapshotsForTests();
    vi.clearAllMocks();
    vi.restoreAllMocks();
});

describe('homeGovernanceEligibilityEngine', () => {
    it('reads only the minimum eligibility Action for one exact Home and Account', async () => {
        const parse = vi.spyOn(HomeGovernanceEligibilityV1Schema, 'safeParse');
        const home = (await upsertServerProfile({ serverUrl: 'https://home-a.example', name: 'Home A' })).id;
        await setActiveServerId(home, { scope: 'device' });
        runtimeFetchMock.mockResolvedValue(response({ teamsEnabled: true, createTeam: true, createTeamForChosenAccount: false }));
        const scope = createServerAccountScope(home, 'member-a')!;

        const release = observeHomeGovernanceEligibility(scope);
        await vi.waitFor(() => expect(getHomeGovernanceEligibilitySnapshot(scope)?.status).toBe('ready'));

        expect(getHomeGovernanceEligibilitySnapshot(scope)?.data).toEqual({
            teamsEnabled: true,
            createTeam: true,
            createTeamForChosenAccount: false,
        });
        expect(runtimeFetchMock).toHaveBeenCalledWith(expect.objectContaining({
            serverUrl: 'https://home-a.example',
            url: 'https://home-a.example/v1/home/governance/eligibility/get',
        }));
        expect(parse).toHaveBeenCalledTimes(1);
        release();
    });

    it('rejects an administrative projection instead of retaining leaked fields', async () => {
        const home = (await upsertServerProfile({ serverUrl: 'https://home-b.example', name: 'Home B' })).id;
        await setActiveServerId(home, { scope: 'device' });
        runtimeFetchMock.mockResolvedValue(response({
            teamsEnabled: true,
            createTeam: true,
            createTeamForChosenAccount: false,
            policy: { revision: 4 },
        }));
        const scope = createServerAccountScope(home, 'member-a')!;

        const release = observeHomeGovernanceEligibility(scope);
        await vi.waitFor(() => expect(getHomeGovernanceEligibilitySnapshot(scope)?.status).toBe('error'));

        expect(getHomeGovernanceEligibilitySnapshot(scope)).toMatchObject({
            data: null,
            error: { kind: 'invalid', retryable: false },
        });
        release();
    });

    it('keeps the last minimum answer stale and read-only when refresh is unreachable', async () => {
        const home = (await upsertServerProfile({ serverUrl: 'https://home-c.example', name: 'Home C' })).id;
        await setActiveServerId(home, { scope: 'device' });
        const scope = createServerAccountScope(home, 'member-a')!;
        runtimeFetchMock.mockResolvedValue(response({ teamsEnabled: true, createTeam: true, createTeamForChosenAccount: false }));

        const release = observeHomeGovernanceEligibility(scope);
        await vi.waitFor(() => expect(getHomeGovernanceEligibilitySnapshot(scope)?.status).toBe('ready'));
        runtimeFetchMock.mockRejectedValue(new Error('offline'));
        await refreshHomeGovernanceEligibility(scope);

        expect(getHomeGovernanceEligibilitySnapshot(scope)).toMatchObject({
            data: { teamsEnabled: true, createTeam: true, createTeamForChosenAccount: false },
            stale: true,
            reachability: 'unreachable',
            error: { kind: 'unreachable', retryable: true },
        });
        release();
    });

    it('refetches minimum eligibility when the focused viewer role or status changes', async () => {
        const home = (await upsertServerProfile({ serverUrl: 'https://home-d.example', name: 'Home D' })).id;
        await setActiveServerId(home, { scope: 'device' });
        const scope = createServerAccountScope(home, 'member-a')!;
        runtimeFetchMock.mockResolvedValue(response({ teamsEnabled: true, createTeam: true, createTeamForChosenAccount: false }));

        const release = observeHomeGovernanceEligibility(scope);
        await vi.waitFor(() => expect(getHomeGovernanceEligibilitySnapshot(scope)?.status).toBe('ready'));
        runtimeFetchMock.mockResolvedValue(response({ teamsEnabled: true, createTeam: false, createTeamForChosenAccount: false }));
        publishHomeAccountChange(home, ['self']);

        await vi.waitFor(() => {
            expect(runtimeFetchMock).toHaveBeenCalledTimes(2);
            expect(getHomeGovernanceEligibilitySnapshot(scope)?.data?.createTeam).toBe(false);
        });
        release();
    });
});
