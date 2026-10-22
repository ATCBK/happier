import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { NO_TEAM_CAPABILITIES_V1, TeamCredentialResourceEntitledPageV1Schema, TeamCredentialResourceReadInputV1Schema, TeamsListInputV1Schema, type TeamSummaryV1 } from '@happier-dev/protocol/teams';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { HomeGovernanceEligibilityV1Schema, HomeGovernanceProjectionV1Schema } from '@happier-dev/protocol/home/governance';

const serverFetchMock = vi.hoisted(() => vi.fn());
const runtimeFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/http/client', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/http/client')>(),
    serverFetch: serverFetchMock,
}));

vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({
    runtimeFetchWithServerReachability: runtimeFetchMock,
}));

// `@/auth/storage/tokenStorage` is an internal domain owner, not a boundary, and a hoisted
// `vi.mock` factory for it deadlocks any suite that also imports `@/dev/testkit`: the barrel
// value-imports `TokenStorage`, so the factory's own dynamic import waits on an evaluation that
// can never finish, and module evaluation is not covered by any Vitest timeout — the file simply
// never collects. The rule and its measurement live at
// `activity/badges/activityBadgeRuntimeTestHelpers.ts#installBadgeHomeIdentities`. The device
// credential store is spied on instead, which is the one thing here that genuinely leaves the
// process.

import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { readAccountAgentProviderRequirements, readAccountProviderDeclarations } from '@/providers/catalog/accountProviderDeclarations';

import { act } from 'react-test-renderer';

import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createDeferred, createRootLayoutFeaturesResponse, homeGovernanceProjectionFixture, renderHook } from '@/dev/testkit';
import { createHomeGovernanceHarness, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import {
    primeServerFeaturesSnapshot,
    resetServerFeaturesClientForTests,
} from '@/sync/api/capabilities/serverFeaturesClient';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { updateEffectiveHomeViewState } from '@/sync/domains/server/selection/homeViewSelectionState';
import { resetTeamsDirectoryEngineForTests } from '@/sync/engine/teams/teamsDirectoryEngine';
import { resetTeamsSnapshotsForTests } from '@/sync/store/teams/teamsSnapshots';
import { resetHomeGovernanceEngineForTests } from '@/sync/engine/home/governance/homeGovernanceEngine';
import { resetHomeGovernanceEligibilityEngineForTests } from '@/sync/engine/home/governance/homeGovernanceEligibilityEngine';
import { clearHomeGovernanceSnapshotsForServer } from '@/sync/store/home/governance/homeGovernanceSnapshots';
import { resetHomeGovernanceEligibilitySnapshotsForTests } from '@/sync/store/home/governance/homeGovernanceEligibilitySnapshots';
import { useHomeAdministrationSettingsAdmission } from '@/hooks/home/useHomeAdministrationSettingsAdmission';

import { useTeamsDirectory } from './useTeamsDirectory';
import { useHomeTeamCredentialModelCatalog } from './useHomeTeamCredentialModelCatalog';
import { useTeamsDestinationShown } from './useTeamsDestinationShown';

function tokenForSub(sub: string): string {
    const payload = globalThis.btoa(JSON.stringify({ sub }))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
    return `e30.${payload}.signature`;
}

function team(id: string, name = `Team ${id}`, archivedAt: number | null = null): TeamSummaryV1 {
    return {
        id,
        name,
        description: null,
        logo: null,
        archivedAt,
        recovery: null,
        policy: {
            v: 1,
            sessionCreationPolicy: 'team_default',
            externalSharingPolicy: 'allowed',
            defaultSessionHistoryAccess: 'from_membership',
            admissionMode: 'invite_only',
            authenticationPolicy: null,
        },
        viewerRole: 'member',
        capabilities: NO_TEAM_CAPABILITIES_V1,
        admission: { historyChoice: { admin: 'choice', member: 'choice', guest: 'hidden' } },
        counts: null,
    };
}

async function addHome(name: string, serverUrl: string, teamsEnabled: boolean): Promise<string> {
    const id = (await upsertServerProfile({ serverUrl, name })).id;
    // The real Home payload, with only the canonical `teams` bit varied through
    // its own writer: the enabled-bit path is the feature owner's, not this
    // test's, so a moved bit fails here instead of silently reading as absent.
    const features = createRootLayoutFeaturesResponse();
    // The shared Home fixture predates this feature, so its container is seeded
    // here; the bit's location stays owned by the protocol writer, so a moved
    // enabled-bit path fails this test instead of reading as a silent absence.
    (features.features as Record<string, unknown>).teams = { enabled: false };
    expect(tryWriteServerEnabledBitInPlace(features, 'teams', teamsEnabled)).toBe(true);
    primeServerFeaturesSnapshot({ serverId: id, snapshot: { status: 'ready', features } });
    await updateEffectiveHomeViewState((current) => ({
        ...current, activeTargetKind: 'server', activeTargetId: id,
    }), { scope: 'device' });
    return id;
}

let getCredentialsForServerUrlMock: MockInstance<typeof TokenStorage.getCredentialsForServerUrl>;

beforeEach(() => {
    serverFetchMock.mockReset();
    runtimeFetchMock.mockReset();
    getCredentialsForServerUrlMock = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl');
    getCredentialsForServerUrlMock.mockResolvedValue({ token: tokenForSub('account') });
    resetServerFeaturesClientForTests();
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
});

afterEach(() => {
    resetTeamsDirectoryEngineForTests();
    resetTeamsSnapshotsForTests();
    resetServerFeaturesClientForTests();
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

describe('useTeamsDirectory', () => {
    it('combines all directory sequences and continues each cursor independently', async () => {
        const home = await addHome('Home A', 'https://home-a.example', true);
        await setActiveServerId(home, { scope: 'device' });
        runtimeFetchMock.mockImplementation(async (request) => {
            const input = TeamsListInputV1Schema.parse(JSON.parse(String(request.init.body)));
            const archived = input.archived === 'archived';
            const id = `${input.archived}-${input.cursor ? '2' : '1'}`;
            return new Response(JSON.stringify({
                items: [team(id, id, archived ? 1 : null)],
                nextCursor: input.cursor ? null : `${input.archived}-next`,
            }), { status: 200 });
        });
        const rendered = await renderHook(() => useTeamsDirectory({ archived: 'all' }));
        try {
            await vi.waitFor(() => {
                expect(rendered.getCurrent().rows.map((row) => row.team.name)).toEqual(['active-1']);
                expect(rendered.getCurrent().archivedRows.map((row) => row.team.name)).toEqual(['archived-1']);
            });
            expect(rendered.getCurrent().partial).toBe(false);
            expect(rendered.getCurrent().hasMore).toBe(true);
            await act(async () => { rendered.getCurrent().loadMore(); });
            await vi.waitFor(() => {
                expect(rendered.getCurrent().rows.map((row) => row.team.name)).toEqual(['active-1', 'active-2']);
                expect(rendered.getCurrent().archivedRows.map((row) => row.team.name)).toEqual(['archived-1', 'archived-2']);
                expect(rendered.getCurrent().hasMore).toBe(false);
            });
            const continuations = runtimeFetchMock.mock.calls
                .map(([request]) => TeamsListInputV1Schema.parse(JSON.parse(String(request.init.body))))
                .filter((input) => input.cursor)
                .map((input) => [input.archived, input.cursor]);
            expect(continuations).toEqual(expect.arrayContaining([
                ['active', 'active-next'], ['archived', 'archived-next'],
            ]));
        } finally {
            await rendered.unmount();
        }
    });

    it('keeps answered rows while the other sequence loads, fails and retries', async () => {
        const home = await addHome('Home A', 'https://home-a.example', true);
        await setActiveServerId(home, { scope: 'device' });
        const archivedPage = createDeferred<Response>();
        let retrying = false;
        runtimeFetchMock.mockImplementation(async (request) => {
            const input = TeamsListInputV1Schema.parse(JSON.parse(String(request.init.body)));
            if (input.archived === 'archived' && !retrying) {
                return archivedPage.promise;
            }
            return new Response(JSON.stringify({
                items: [team(input.archived, input.archived, input.archived === 'archived' ? 1 : null)],
                nextCursor: null,
            }), { status: 200 });
        });
        const rendered = await renderHook(() => useTeamsDirectory({ archived: 'all' }));
        try {
            await vi.waitFor(() => expect(rendered.getCurrent().rows).toHaveLength(1));
            expect(rendered.getCurrent().kind).toBe('ready');
            expect(rendered.getCurrent().partial).toBe(true);
            expect(rendered.getCurrent().unavailableHomes).toEqual([
                expect.objectContaining({ serverId: home, reason: 'loading' }),
            ]);
            await act(async () => { archivedPage.reject(new Error('network down')); });
            await vi.waitFor(() => expect(rendered.getCurrent().unavailableHomes).toEqual([
                expect.objectContaining({ serverId: home, reason: 'offline', retryable: true }),
            ]));
            expect(rendered.getCurrent().rows).toHaveLength(1);
            retrying = true;
            await act(async () => { rendered.getCurrent().refresh(); });
            await vi.waitFor(() => {
                expect(rendered.getCurrent().archivedRows).toHaveLength(1);
                expect(rendered.getCurrent().partial).toBe(false);
                expect(rendered.getCurrent().unavailableHomes).toEqual([]);
            });
            expect(rendered.getCurrent().rows).toHaveLength(1);
        } finally {
            archivedPage.resolve(new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 }));
            await rendered.unmount();
        }
    });

    it('binds a local Home alias to its published identity without borrowing the focused Home Account', async () => {
        const home = createHomeGovernanceHarness();
        const named = await home.addHome({ name: 'Named Home', serverUrl: 'https://team-alias.example',
            serverIdentityId: 'srv_team_alias', accountId: 'named-account', currentAccount: true,
            teamsEnabled: true, credentialResourcesEnabled: true });
        await home.addHome({ name: 'Focused Home', serverUrl: 'https://team-focused.example',
            serverIdentityId: 'srv_team_focused', accountId: 'focused-account', currentAccount: true,
            teamsEnabled: true, credentialResourcesEnabled: true });
        expect(named).not.toBe('srv_team_alias');
        home.answer(named, '/v1/teams/list', { body: { items: [team('shared-id', 'Named Team')], nextCursor: null } });
        const catalogRequest = bindHomeDomainActionHttpRequestV1('teams.credentials.entitled.list', { teamId: 'shared-id' });
        home.answer(named, catalogRequest.path, { body: TeamCredentialResourceEntitledPageV1Schema.parse({ resources: [], nextCursor: null }) });
        home.answer(named, bindHomeDomainActionHttpRequestV1('home.governance.get', {}).path, {
            body: HomeGovernanceProjectionV1Schema.parse(homeGovernanceProjectionFixture({
                viewer: { accountId: 'named-account', homeRole: 'owner', status: 'active' },
            })),
        });
        home.answer(named, bindHomeDomainActionHttpRequestV1('home.governance.eligibility.get', {}).path, {
            body: HomeGovernanceEligibilityV1Schema.parse({ teamsEnabled: true, createTeam: true,
                createTeamForChosenAccount: false, showTeams: true }),
        });
        getCredentialsForServerUrlMock.mockImplementation(async (url) => {
            const token = home.findByServerUrl(url)?.token;
            return token ? { token } : null;
        });
        runtimeFetchMock.mockImplementation(async (request) => {
            const headers = new Headers(request.init?.headers);
            if (request.token) headers.set('Authorization', `Bearer ${request.token}`);
            return home.request(request.url, { ...request.init, headers });
        });
        serverFetchMock.mockImplementation((path, init) => home.request(new URL(path, getActiveServerSnapshot().serverUrl), init));
        // Action preparation uses the real endpoint fetch, below the reachability
        // fetch used by directory reads. Both HTTP leaves answer from the same Home.
        setRuntimeFetch((input, init) => home.request(input, init));
        const rendered = await renderHook(() => ({
            directory: useTeamsDirectory({ serverIds: [named] }),
            catalog: useHomeTeamCredentialModelCatalog({ serverId: named, enabled: true }),
            shown: useTeamsDestinationShown([named]),
            administration: useHomeAdministrationSettingsAdmission({ serverIds: [named] }),
        }));
        try {
            await waitForHomeGovernance(() => expect(rendered.getCurrent().directory.rows).toHaveLength(1));
            expect(rendered.getCurrent().directory.rows[0]?.address).toEqual({ serverId: named, teamId: 'shared-id' });
            expect(rendered.getCurrent().directory.scopes).toEqual([{ serverId: 'srv_team_alias', accountId: 'named-account' }]);
            await waitForHomeGovernance(() => expect(rendered.getCurrent().catalog.current).toBe(true));
            expect(rendered.getCurrent().catalog.teamNameById).toEqual({ 'shared-id': 'Named Team' });
            await waitForHomeGovernance(() => expect(rendered.getCurrent().shown).toBe(true));
            await waitForHomeGovernance(() => expect(rendered.getCurrent().administration.admittedServerIds).toEqual([named]));
            const reads = home.requests.filter((request) => request.path.startsWith('/v1/teams'));
            expect(reads.length).toBeGreaterThan(1);
            expect(reads.every((request) => request.serverId === named
                && request.token === home.findByServerUrl('https://team-alias.example')?.token)).toBe(true);
            expect(home.requests.filter((request) => request.path.startsWith('/v1/home/governance')).every((request) => request.serverId === named
                && request.token === home.findByServerUrl('https://team-alias.example')?.token)).toBe(true);
        } finally {
            await rendered.unmount();
            resetRuntimeFetch();
            resetHomeGovernanceEngineForTests();
            resetHomeGovernanceEligibilityEngineForTests();
            clearHomeGovernanceSnapshotsForServer('srv_team_alias');
            resetHomeGovernanceEligibilitySnapshotsForTests();
            await home.reset();
        }
    });

    it.each(['bundled', 'installed'] as const)('loads and reloads the %s Agent application without sharing generic or other Agent catalog rows', async (source) => {
        const home = createHomeGovernanceHarness();
        const serverId = await home.addHome({ name: 'Catalog Home', serverUrl: 'https://team-models.example',
            serverIdentityId: 'srv_team_models', accountId: 'account', currentAccount: true,
            teamsEnabled: true, credentialResourcesEnabled: true });
        home.answer(serverId, '/v1/teams/list', { body: { items: [team('team-1')], nextCursor: null } });
        const path = bindHomeDomainActionHttpRequestV1('teams.credentials.entitled.list', { teamId: 'team-1' }).path;
        let revision = 1;
        let applicationUnavailable = false;
        const agentKey = (id: string) => source === 'installed' ? `agent:acme.agents/${id}` : `agent:happier.agent.${id}/${id}`;
        const multiProtocolAgent = agentKey('opencode');
        const definition = readAccountProviderDeclarations({ kind: 'account' }).find(row => row.definition.managedRuntime)!.definition;
        const declarationProjection = source === 'installed' ? PluginProjectionV2Schema.parse({ v: 2, generation: 7,
            agentsById: Object.fromEntries(['codex', 'claude', 'opencode'].map(id => [id, { id,
                identity: { pluginId: 'acme.agents', localId: id },
                providerRequirements: readAccountAgentProviderRequirements(`agent:happier.agent.${id}/${id}`, { kind: 'account' }),
            }])),
            familiesById: { providers: { family: 'providers', entriesById: {
                'acme.gateway/managed': { id: 'acme.gateway/managed', pluginId: 'acme.gateway',
                    provenance: 'external', sourceKind: 'path', definition: { ...definition, id: 'managed' } },
            } } },
        }) : null;
        home.answer(serverId, path, { select: (input) => {
            const { application } = TeamCredentialResourceReadInputV1Schema.parse(input);
            if (application && applicationUnavailable) return { status: 503, body: { error: 'unavailable' } };
            const modelId = application?.agentTargetKey === multiProtocolAgent ? 'shared-model'
                : application ? `${application.protocol}-${revision}` : '';
            const resource = {
                id: 'shared', teamId: 'team-1', displayName: 'Shared gateway', resourceRevision: revision,
                readiness: { kind: 'available' }, recoveryAction: null,
                mayBroker: true, mayReceiveDirect: false, directMaterialState: 'never_delivered',
                sessionUsePolicy: 'personal_allowed', providerModels: application ? [{
                    selection: { kind: 'team_credential_provider_model', teamId: 'team-1', resourceId: 'shared',
                        expectedResourceRevision: revision, agentTargetKey: application.agentTargetKey, modelId, deliveryMode: 'brokered' },
                    descriptor: { id: modelId, name: modelId }, application, sourceRevision: `source-${revision}`, availability: 'available',
                }] : [], connectedServiceSelections: [],
                sourcePresentation: { kind: 'provider', provider: { identity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' }, definitionRevision: 1 } },
            };
            return { body: TeamCredentialResourceEntitledPageV1Schema.parse({ resources: application ? [resource]
                : [resource, { ...resource, id: 'generic-only',
                    sourcePresentation: { kind: 'connected_service', service: { pluginId: 'happier.service.test', localId: 'chat' } },
                    connectedServiceSelections: [{ source: 'team_resource', resourceId: 'generic-only', deliveryMode: 'brokered' }],
                }], nextCursor: null }) };
        } });
        getCredentialsForServerUrlMock.mockImplementation(async (url) => {
            const token = home.findByServerUrl(url)?.token;
            return token ? { token } : null;
        });
        runtimeFetchMock.mockImplementation(async (request) => {
            const headers = new Headers(request.init?.headers);
            if (request.token) headers.set('Authorization', `Bearer ${request.token}`);
            return home.request(request.url, { ...request.init, headers });
        });
        setRuntimeFetch((input, init) => home.request(input, init));
        const codex = agentKey('codex');
        const claude = agentKey('claude');
        const rendered = await renderHook(({ agentTargetKey }: { agentTargetKey: string }) => ({
            selected: useHomeTeamCredentialModelCatalog({ serverId, enabled: true, agentTargetKey, declarationProjection,
                machineId: source === 'installed' ? 'installed-machine' : null }),
            generic: useHomeTeamCredentialModelCatalog({ serverId, enabled: true }),
        }), { initialProps: { agentTargetKey: codex } });
        const models = () => rendered.getCurrent().selected.resources.flatMap(row => row.providerModels.map(model => model.descriptor.id));
        try {
            await waitForHomeGovernance(() => expect(rendered.getCurrent().selected.current).toBe(true));
            expect(models()).toEqual(['openai-responses-1']);
            expect(rendered.getCurrent().selected.resources.map(row => row.id)).toEqual(['shared', 'generic-only']);
            expect(rendered.getCurrent().selected.resources[1]?.connectedServiceSelections).toEqual([
                { source: 'team_resource', resourceId: 'generic-only', deliveryMode: 'brokered' },
            ]);
            expect(rendered.getCurrent().generic.resources.flatMap(row => row.providerModels)).toEqual([]);
            await rendered.rerender({ agentTargetKey: claude });
            expect(models().some(id => id.startsWith('openai-responses'))).toBe(false);
            await waitForHomeGovernance(() => expect(rendered.getCurrent().selected.current).toBe(true));
            expect(models()).toEqual(['anthropic-1']);
            revision = 2;
            await act(async () => { await rendered.getCurrent().selected.reload(); });
            await waitForHomeGovernance(() => expect(rendered.getCurrent().selected.current).toBe(true));
            expect(models()).toEqual(['anthropic-2']);
            expect(rendered.getCurrent().generic.resources.flatMap(row => row.providerModels)).toEqual([]);
            await rendered.rerender({ agentTargetKey: codex });
            await waitForHomeGovernance(() => expect(rendered.getCurrent().selected.current).toBe(true));
            expect(models()).toEqual(['openai-responses-2']);
            const reads = home.requests.filter(request => request.path === path);
            expect(reads.some(request => JSON.stringify(request.input).includes('cliproxyapi-openai-responses'))).toBe(true);
            if (source === 'installed') expect(reads.some(request => JSON.stringify(request.input).includes('acme.gateway'))).toBe(true);
            await rendered.rerender({ agentTargetKey: multiProtocolAgent });
            await waitForHomeGovernance(() => expect(rendered.getCurrent().selected.current).toBe(true));
            expect(models()).toEqual(['shared-model']);
            const model = rendered.getCurrent().selected.resources[0]?.providerModels[0];
            expect(model?.application.endpointTemplateId).toBe('cliproxyapi-openai-responses');
            expect(rendered.getCurrent().selected.currentResourceKeys.has('team-1:generic-only')).toBe(true);
            applicationUnavailable = true;
            await act(async () => { await rendered.getCurrent().selected.reload(); });
            expect(rendered.getCurrent().selected.current).toBe(false);
            expect(models()).toEqual(['shared-model']);
            expect(rendered.getCurrent().selected.currentResourceKeys.has('team-1:shared')).toBe(false);
            expect(rendered.getCurrent().selected.currentResourceKeys.has('team-1:generic-only')).toBe(true);
            await rendered.rerender({ agentTargetKey: 'agent:acme.unknown/agent' });
            expect(models()).toEqual([]);
            expect(rendered.getCurrent().selected.current).toBe(false);
            // Generic Connected Account choices are independent of Agent model requirements.
            expect(rendered.getCurrent().selected.resources.find(row => row.id === 'generic-only')
                ?.connectedServiceSelections).toEqual([
                { source: 'team_resource', resourceId: 'generic-only', deliveryMode: 'brokered' },
            ]);
            expect(rendered.getCurrent().selected.currentResourceKeys.has('team-1:generic-only')).toBe(true);
        } finally {
            await rendered.unmount();
            resetRuntimeFetch();
            await home.reset();
        }
    });

    it('projects a failed Team credential discovery and retries the directory even with no resource rows', async () => {
        const home = await addHome('Home A', 'https://home-a.example', true);
        await setActiveServerId(home, { scope: 'device' });
        runtimeFetchMock.mockRejectedValue(new Error('network down'));
        const rendered = await renderHook(() => useHomeTeamCredentialModelCatalog({ serverId: home, enabled: true }));
        await vi.waitFor(() => expect(rendered.getCurrent().condition).toEqual({ reason: 'offline', retryable: true }));
        expect(rendered.getCurrent().resources).toEqual([]);
        runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 }));
        await act(async () => { await rendered.getCurrent().reload(); });
        await vi.waitFor(() => expect(rendered.getCurrent().current).toBe(true));
        expect(rendered.getCurrent().condition).toBeNull();
        await rendered.unmount();
    });

    it('does not claim a disabled Team credential catalog is stale or loading', async () => {
        const home = await addHome('Home A', 'https://home-a.example', true);
        await setActiveServerId(home, { scope: 'device' });
        const rendered = await renderHook(() => useHomeTeamCredentialModelCatalog({ serverId: null, enabled: false }));
        expect(rendered.getCurrent().condition).toBeNull();
        expect(runtimeFetchMock).not.toHaveBeenCalled();
        await rendered.unmount();
    });
    it('reads each capable Home as the Account that Home is signed in as', async () => {
        const home = await addHome('Home A', 'https://home-a.example', true);
        await setActiveServerId(home, { scope: 'device' });
        runtimeFetchMock.mockImplementation(async () => new Response(
            JSON.stringify({ items: [team('t1', 'Acme')], nextCursor: null }),
            { status: 200 },
        ));

        const rendered = await renderHook(() => useTeamsDirectory());
        await vi.waitFor(() => {
            expect(rendered.getCurrent().rows).toHaveLength(1);
        });

        const current = rendered.getCurrent();
        expect(current.kind).toBe('ready');
        expect(current.rows[0]?.address).toEqual({ serverId: home, teamId: 't1' });
        expect(current.rows[0]?.homeName).toBe('Home A');
        expect(runtimeFetchMock.mock.calls.some(([request]) => request.url === 'https://home-a.example/v1/teams/list')).toBe(true);
        await rendered.unmount();
    });

    it('settles a Home whose saved credential this device cannot read, and re-reads it on Retry', async () => {
        const home = await addHome('Home A', 'https://home-a.example', true);
        await setActiveServerId(home, { scope: 'device' });
        runtimeFetchMock.mockImplementation(async () => new Response(
            JSON.stringify({ items: [team('t1', 'Acme')], nextCursor: null }),
            { status: 200 },
        ));
        getCredentialsForServerUrlMock.mockImplementation(async (
            _serverUrl: string,
            options?: Readonly<{ storageReadFailure?: 'absent' | 'surface' }>,
        ) => {
            if (options?.storageReadFailure === 'surface') throw new Error('secure storage read failed');
            return null;
        });

        const rendered = await renderHook(() => useTeamsDirectory());
        // Neither a spinner that never settles nor a silent sign-out.
        await vi.waitFor(() => {
            expect(rendered.getCurrent().unavailableHomes).toEqual([
                expect.objectContaining({ serverId: home, reason: 'credential_unreadable', retryable: true }),
            ]);
        });
        expect(runtimeFetchMock).not.toHaveBeenCalled();

        getCredentialsForServerUrlMock.mockResolvedValue({ token: tokenForSub('account') });
        await act(async () => {
            rendered.getCurrent().refresh();
        });
        await vi.waitFor(() => {
            expect(rendered.getCurrent().rows).toHaveLength(1);
        });
        expect(rendered.getCurrent().unavailableHomes).toEqual([]);
        await rendered.unmount();
    });

    it('never asks a Home whose feature decision refused Teams', async () => {
        const refusing = await addHome('Home B', 'https://home-b.example', false);
        await setActiveServerId(refusing, { scope: 'device' });

        const rendered = await renderHook(() => useTeamsDirectory());
        // Nothing is claimed about a Home that said no, and nothing is asked of
        // it: an admission refusal is a settled answer, not an empty directory.
        await vi.waitFor(() => expect(rendered.getCurrent().kind).toBe('loading'));
        expect(runtimeFetchMock).not.toHaveBeenCalled();
        expect(rendered.getCurrent().rows).toEqual([]);
        expect(rendered.getCurrent().unavailableHomes).toEqual([]);
        await rendered.unmount();
    });

    it('names a Home that could not answer instead of showing an empty directory', async () => {
        const home = await addHome('Home A', 'https://home-a.example', true);
        await setActiveServerId(home, { scope: 'device' });
        runtimeFetchMock.mockImplementation(async () => {
            throw new Error('network down');
        });

        const rendered = await renderHook(() => useTeamsDirectory());
        await vi.waitFor(() => {
            expect(rendered.getCurrent().unavailableHomes).toHaveLength(1);
        });

        const current = rendered.getCurrent();
        expect(current.rows).toEqual([]);
        expect(current.partial).toBe(true);
        // "No Teams" would be a false statement about a Home that never answered.
        expect(current.kind).not.toBe('empty');
        expect(current.unavailableHomes[0]).toMatchObject({
            serverId: home,
            homeName: 'Home A',
            reason: 'offline',
            retryable: true,
        });
        await rendered.unmount();
    });

    it('reads the exact Home a Home-scoped surface named even when the view selection is elsewhere', async () => {
        // The Home administration Teams list is *about* Home A. Which Home the
        // person happens to be looking at is a different question, and letting
        // it decide here is what made that screen claim "no Teams".
        const administered = await addHome('Home A', 'https://home-a.example', true);
        const focused = await addHome('Home B', 'https://home-b.example', true);
        await setActiveServerId(focused, { scope: 'device' });
        runtimeFetchMock.mockImplementation(async () => new Response(
            JSON.stringify({ items: [team('t1', 'Acme')], nextCursor: null }),
            { status: 200 },
        ));

        const rendered = await renderHook(() => useTeamsDirectory({
            scope: 'administered',
            serverIds: [administered],
        }));
        await vi.waitFor(() => {
            expect(rendered.getCurrent().rows).toHaveLength(1);
        });

        expect(rendered.getCurrent().rows[0]?.address).toEqual({ serverId: administered, teamId: 't1' });
        // The named Home is the only Home asked; naming one never widens the read.
        expect(runtimeFetchMock.mock.calls.every(
            (call) => String(call[0]?.url).startsWith('https://home-a.example/'),
        )).toBe(true);
        await rendered.unmount();
    });

    it('still refuses a named Home whose own feature decision said no', async () => {
        const named = await addHome('Home A', 'https://home-a.example', false);
        const focused = await addHome('Home B', 'https://home-b.example', true);
        await setActiveServerId(focused, { scope: 'device' });

        const rendered = await renderHook(() => useTeamsDirectory({
            scope: 'administered',
            serverIds: [named],
        }));
        await vi.waitFor(() => expect(rendered.getCurrent().kind).toBe('loading'));
        expect(runtimeFetchMock).not.toHaveBeenCalled();
        await rendered.unmount();
    });

    it('requests the archived sequence only once that section is opened', async () => {
        const home = await addHome('Home A', 'https://home-a.example', true);
        await setActiveServerId(home, { scope: 'device' });
        runtimeFetchMock.mockImplementation(async () => new Response(
            JSON.stringify({ items: [], nextCursor: null }),
            { status: 200 },
        ));

        const disabled = await renderHook(() => useTeamsDirectory({ archived: 'archived', enabled: false }));
        expect(runtimeFetchMock).not.toHaveBeenCalled();
        expect(disabled.getCurrent().kind).toBe('loading');
        await disabled.unmount();

        const opened = await renderHook(() => useTeamsDirectory({ archived: 'archived' }));
        await vi.waitFor(() => {
            expect(runtimeFetchMock).toHaveBeenCalled();
        });
        const listRequest = runtimeFetchMock.mock.calls.find(([request]) => request.url === 'https://home-a.example/v1/teams/list')?.[0];
        expect(listRequest).toBeDefined();
        expect(JSON.parse(String(listRequest.init.body))).toMatchObject({
            scope: 'member',
            archived: 'archived',
        });
        await opened.unmount();
    });
});
