import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { act, createDeferred, createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { createReadyMachineAgentInventoryFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { AccessibleMachineAccessV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { createPlainSessionByIdResponseFixture, createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { buildConnectedAccountPurposeTargetChoices } from '@/sync/domains/connectedServices/connectedAccountPurposeTargetChoices';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';

const network = await installSessionOpsNetworkBoundary();
const { storage } = await import('@/sync/domains/state/storageStore');
const { useSessionReadiness } = await import('./useSessionReadiness');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { createUiSessionStatusGet } = await import('@/sync/ops/actions/sessionStatusAction');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');

afterEach(() => { standardCleanup(); storage.setState(storage.getInitialState(), true); network.resetRequests(); });
afterAll(() => network.dispose());

it('updates demanded readiness after a pushed Session access change without polling or unrelated reads', async () => {
    const home = await network.addHome('https://readiness-access.test', 'alice');
    const features = createRootLayoutFeaturesResponse();
    tryWriteServerEnabledBitInPlace(features, 'sharing.session', true);
    primeServerFeaturesSnapshot({ serverId: home.id, snapshot: { status: 'ready', features } });
    const scope = { serverId: home.id, accountId: 'alice' };
    const accountLifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    let level: 'view' | 'admin' = 'view';
    const session = createSessionFixture({ id: 'shared-bot', serverId: home.id, encryptionMode: 'plain',
        metadata: { machineId: 'sleeping', path: '/work', host: 'laptop', flavor: 'codex' },
        access: createSessionAccessFixture(level) });
    storage.setState({ machineListByServerId: { [home.id]: [createMachineFixture({ id: 'sleeping', active: false, activeAt: 0 })] } });
    network.resetRequests();
    network.setHttpResponder(async input => new URL(String(input)).pathname === `/v2/sessions/${session.id}`
        ? Response.json(createPlainSessionByIdResponseFixture({ ...session, access: createSessionAccessFixture(level) })) : null);
    const hook = await renderHook(({ enabled }: { enabled: boolean }) => useSessionReadiness({
        accountLifetime, sessionId: session.id, enabled,
    }), { initialProps: { enabled: true } });
    await vi.waitFor(() => expect(hook.getCurrent().readiness).toMatchObject({ cause: 'invocation', invocation: { level: 'view' } }));
    const readCount = () => network.httpRequests.filter(request => new URL(request.url).pathname === `/v2/sessions/${session.id}`).length;
    const before = readCount();
    level = 'admin';
    await act(async () => {
        publishHomeAccountChange('another-home', [session.id], { changeKinds: ['share'] });
        publishHomeAccountChange(home.id, ['another-session'], { changeKinds: ['share'] });
        publishHomeAccountChange(home.id, [session.id], { changeKinds: ['artifact'] });
    });
    expect(readCount()).toBe(before);
    await act(async () => { publishHomeAccountChange(home.id, [session.id], { changeKinds: ['share'] }); });
    await vi.waitFor(() => expect(hook.getCurrent().readiness).toMatchObject({ cause: 'machine', invocation: { level: 'admin' } }));
    expect(readCount()).toBe(before + 1);
    await hook.rerender({ enabled: false });
    await act(async () => { publishHomeAccountChange(home.id, [session.id], { changeKinds: ['share'] }); });
    expect(readCount()).toBe(before + 1);
});

it('demands the operation Account purpose and observes reconnect acknowledgement without changing conversation readiness', async () => {
    const home = await network.addHome('https://readiness-credential.test', 'alice');
    const scope = { serverId: home.id, accountId: 'alice' };
    const accountLifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const service = { pluginId: 'acme.external', localId: 'account' };
    const purpose = { consumer: { pluginId: 'acme.external', localId: 'helper' }, purpose: 'outside-write' };
    const account = { service, accountId: 'work' };
    const teamSelection = { source: 'team_resource' as const, resourceId: 'shared-resource', deliveryMode: 'direct' as const, disclosedMember: account };
    const teamResource = TeamCredentialResourceCatalogEntryV1Schema.parse({ id: teamSelection.resourceId, teamId: 'team', displayName: 'Shared Acme',
        resourceRevision: 1, readiness: { kind: 'limit_reached', metric: 'inference_requests', resetsAtUtc: '2026-10-20T00:00:00Z' },
        recoveryAction: 'source_owner_action', mayBroker: false, mayReceiveDirect: true, directMaterialState: 'current',
        sessionUsePolicy: 'personal_allowed', providerModels: [], connectedServiceSelections: [teamSelection], sourcePresentation: { kind: 'connected_service', service } });
    const choice = buildConnectedAccountPurposeTargetChoices({ declaration: { purpose: purpose.purpose, service, required: true },
        selectedTarget: null, accounts: [], groups: [], labelsByKey: {}, serviceTitle: 'Acme', resolveAuthentication: () => null,
        teamResources: [{ ...teamResource, readiness: { kind: 'available' } }] }).find(candidate => candidate.teamResource);
    if (!choice?.teamResource) throw new Error('Expected the existing setup owner to offer the Team binding');
    const credentialTeamSelection = { purpose, ...choice.teamResource };
    const teamPath = new URL(bindHomeDomainActionHttpRequestV1('teams.credentials.entitled.list', { teamId: 'team' }).path, 'https://readiness-credential.test').pathname;
    let useTeamResource = false;
    let sharedInvoker = false;
    let legacySharedLocality = false;
    const session = createSessionFixture({ id: 'credential-bot', serverId: home.id, encryptionMode: 'plain',
        metadata: { machineId: 'credential-machine', path: '/work', host: 'server', flavor: 'codex' }, access: createSessionAccessFixture('owner') });
    const machine = createMachineFixture({ id: 'credential-machine', active: true, activeAt: Date.now(),
        access: AccessibleMachineAccessV1Schema.parse({ custodian: { accountId: 'alice', displayName: 'Alice' },
            role: 'manage', resourceMode: 'plain', accessState: 'ready' }) });
    storage.setState({ machineListByServerId: { [home.id]: [machine] } });
    let connected = false;
    const profile = () => AccountProfileSchema.parse({ id: 'alice', connectedAccountsV4: [{ ref: account, status: 'connected',
        revisionSemantics: 'revisioned', credentialRevision: `csr_${'a'.repeat(22)}`, authenticationModeId: 'manual',
        configurationReady: true, configurationRevision: null, expiresAt: connected ? null : 1 }] });
    network.resetRequests();
    network.setHttpResponder(async input => {
        const path = new URL(String(input)).pathname;
        if (path === `/v2/sessions/${session.id}`) {
            const response = createPlainSessionByIdResponseFixture(sharedInvoker
                ? { ...session, access: createSessionAccessFixture('edit') } : session);
            // Retained layout-0 Sessions expose locality in shared metadata; layout-1 recipients do not.
            return Response.json(legacySharedLocality ? { session: { ...response.session,
                metadataLayoutVersion: 0, metadata: JSON.stringify(session.metadata) } } : response);
        }
        if (path === '/v1/account/profile') return Response.json(profile());
        if (path === teamPath) return Response.json({ resources: [teamResource], nextCursor: null });
        if (path.endsWith('/connected-accounts/purposes')) return Response.json({ status: 'present', revision: 1,
            content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [{ purpose, target: { kind: 'account', account } }] } } } });
        return null;
    });
    const native = createReadyMachineAgentInventoryFixture([{ agentId: 'codex', title: 'Codex' }]);
    const projection = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection: {
        ...native.projection,
        installedPackagesById: { ...native.projection.installedPackagesById, 'acme.external': {
            id: 'acme.external', displayName: 'Acme', enabled: true, source: { kind: 'builtin', locator: 'acme.external' } } },
        resourcesById: { ...native.projection.resourcesById, helper: { id: 'helper', pluginId: 'acme.external', resourceKind: 'config', path: 'helper.json',
            connectedAccountPurposes: [{ purpose: purpose.purpose, serviceRefs: [service] }] } },
        familiesById: { ...native.projection.familiesById, connectedAccounts: { family: 'connectedAccounts', entriesById: { account: {
            id: service.localId, serviceId: service.localId, pluginId: service.pluginId, provenance: 'external', sourceKind: 'test', title: 'Acme',
            authentication: { defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none', fields: [] }] },
            capabilities: [], availability: { state: 'available', reason: 'enabled' }, diagnostics: [],
        } } } },
    } });
    network.setRpcAckResponder(async request => {
        if (request.method.includes('contributionRegistryProjection.describe')) return { ok: true, result: projection };
        if (request.method === 'daemon.agents.install.list') return { ok: true, result: { jobs: [] } };
        if (request.method === 'capabilities.detect') return { ok: true, result: native.capabilities };
        throw new Error(`Unexpected credential diagnostic effect ${request.method}`);
    });
    const hook = await renderHook(({ operation }: { operation: 'conversation' | 'credential' }) => useSessionReadiness({
        accountLifetime, sessionId: session.id, enabled: true, operation, credentialPurpose: purpose,
        ...(useTeamResource ? { credentialTeamSelection } : {}),
    }), { initialProps: { operation: 'credential' } });
    await vi.waitFor(() => expect(hook.getCurrent().readiness).toMatchObject({ operation: 'credential', status: 'unavailable', cause: 'credential',
        credential: { kind: 'personal', purpose, usable: false } }));
    expect(hook.getCurrent().repair).toEqual({ actionId: 'connectedServices.authentication.beginReconnect',
        input: { machineId: machine.id, account } });
    connected = true; // Acknowledgement at the authentication boundary; the same owner must be reread.
    await act(async () => { await hook.getCurrent().refresh(); });
    await vi.waitFor(() => expect(hook.getCurrent().readiness).toMatchObject({ operation: 'credential', status: 'ready',
        credential: { kind: 'personal', usable: true, repair: null } }));
    connected = false;
    await hook.rerender({ operation: 'conversation' });
    await vi.waitFor(() => expect(hook.getCurrent().readiness).toMatchObject({ operation: 'conversation', status: 'ready', credential: { kind: 'not_required' } }));
    useTeamResource = true;
    await hook.rerender({ operation: 'credential' });
    await vi.waitFor(() => expect(hook.getCurrent().readiness).toMatchObject({ operation: 'credential', status: 'unavailable', cause: 'credential',
        credential: { kind: 'team', teamId: teamResource.teamId, resourceId: teamResource.id,
            readiness: teamResource.readiness, recoveryAction: teamResource.recoveryAction } }));
    expect(hook.getCurrent().repair).toBeNull(); // Team source repair stays at its own resource owner.
    sharedInvoker = true;
    const privateReads = network.httpRequests.filter(request => request.url.endsWith('/v1/account/profile') || request.url.endsWith('/connected-accounts/purposes')).length;
    await act(async () => { await hook.getCurrent().refresh(); });
    await vi.waitFor(() => expect(hook.getCurrent().readiness?.credential).toEqual({ kind: 'unknown' }));
    legacySharedLocality = true;
    await act(async () => { await hook.getCurrent().refresh(); });
    await vi.waitFor(() => expect(hook.getCurrent().readiness?.credential).toMatchObject({ kind: 'team', readiness: teamResource.readiness }));
    expect(network.httpRequests.filter(request => request.url.endsWith('/v1/account/profile') || request.url.endsWith('/connected-accounts/purposes'))).toHaveLength(privateReads);
    useTeamResource = false;
    await hook.rerender({ operation: 'conversation' });
    await hook.rerender({ operation: 'credential' });
    await vi.waitFor(() => expect(hook.getCurrent().readiness?.credential).toEqual({ kind: 'unknown' }));
    expect(network.httpRequests.filter(request => request.url.endsWith('/v1/account/profile') || request.url.endsWith('/connected-accounts/purposes'))).toHaveLength(privateReads);
});

it('demands the exact Session only while open and keeps an offline Bot visible with its cause', async () => {
    const home = await network.addHome('https://readiness-row.test', 'alice');
    const scope = { serverId: home.id, accountId: 'alice' };
    const accountLifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const session = createSessionFixture({ id: 'offline-bot', serverId: home.id, encryptionMode: 'plain',
        metadata: { machineId: 'sleeping', path: '/work', host: 'laptop', flavor: 'codex' }, access: createSessionAccessFixture('owner') });
    storage.setState({ machineListByServerId: { [home.id]: [createMachineFixture({ id: 'sleeping', active: false, activeAt: 0 })] } });
    network.resetRequests();
    network.setHttpResponder(async input => new URL(String(input)).pathname === `/v2/sessions/${session.id}`
        ? Response.json(createPlainSessionByIdResponseFixture(session)) : null);
    let renders = 0;
    const hook = await renderHook(({ enabled }: { enabled: boolean }) => {
        renders += 1;
        return useSessionReadiness({ accountLifetime, sessionId: session.id, enabled });
    }, { initialProps: { enabled: false } });
    expect(hook.getCurrent().readiness).toBeNull();
    expect(network.httpRequests).toEqual([]);
    expect(network.requests).toEqual([]);
    expect(network.credentialRequests).toEqual([]);
    await hook.rerender({ enabled: true });
    await vi.waitFor(() => expect(hook.getCurrent().readiness).toMatchObject({ configured: true,
        status: 'unavailable', cause: 'machine', machine: { status: 'offline', machineId: 'sleeping' } }));
    expect(hook.getCurrent().repair).toBeNull();
    expect(network.requests).toEqual([]);
    const requested = network.httpRequests.length;
    const openedRenders = renders;
    await act(async () => { storage.setState({ socketStatus: 'connecting' }); });
    expect(renders).toBe(openedRenders);
    expect(network.httpRequests).toHaveLength(requested);
    await hook.rerender({ enabled: false });
    const closedRenders = renders;
    await act(async () => { storage.setState({ socketStatus: 'disconnected' }); });
    expect(renders).toBe(closedRenders);
    await hook.getCurrent().refresh();
    expect(network.httpRequests).toHaveLength(requested);
});

it('shares exact native repair facts with the status Action and refreshes through the inventory owner', async () => {
    const home = await network.addHome('https://readiness-native.test', 'alice');
    const scope = { serverId: home.id, accountId: 'alice' };
    const accountLifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const session = createSessionFixture({ id: 'native-bot', serverId: home.id, encryptionMode: 'plain',
        metadata: { machineId: 'native-machine', path: '/work', host: 'server', flavor: 'codex' }, access: createSessionAccessFixture('owner') });
    const machine = createMachineFixture({ id: 'native-machine', active: true, activeAt: Date.now(),
        access: AccessibleMachineAccessV1Schema.parse({ custodian: { accountId: 'alice', displayName: 'Alice' },
            role: 'manage', resourceMode: 'plain', accessState: 'ready' }) });
    storage.setState({ machineListByServerId: { [home.id]: [machine] } });
    network.resetRequests();
    network.setHttpResponder(async input => new URL(String(input)).pathname === `/v2/sessions/${session.id}`
        ? Response.json(createPlainSessionByIdResponseFixture(session)) : null);
    const native = createReadyMachineAgentInventoryFixture([{ agentId: 'codex', title: 'Codex' }]);
    let signedIn = false;
    network.setRpcAckResponder(async request => {
        if (request.method.includes('contributionRegistryProjection.describe')) return { ok: true,
            result: { protocolVersion: 1, projection: native.projection } };
        if (request.method === 'daemon.agents.install.list') return { ok: true, result: { jobs: [] } };
        if (request.method === 'capabilities.detect') return { ok: true, result: { protocolVersion: 1, results: { 'cli.codex': {
            ...native.capabilities.results['cli.codex'], data: { ...native.capabilities.results['cli.codex']!.data,
                signIn: { status: signedIn ? 'signedIn' : 'signedOut', loginSupport: 'login_terminal' },
                isLoggedIn: signedIn, authStatus: { state: signedIn ? 'logged_in' : 'logged_out', checkedAt: 1 } },
        } } } };
        throw new Error(`Unexpected readiness effect ${request.method}`);
    });
    const hook = await renderHook(() => useSessionReadiness({ accountLifetime, sessionId: session.id, enabled: true }));
    const repair = { actionId: 'machines.agents.signIn.start', input: { machineId: machine.id, agentId: 'codex', method: 'native' } };
    await vi.waitFor(() => expect(hook.getCurrent().repair).toEqual(repair));
    const account = await captureLazyActionAccountContext(home.id);
    try {
        expect(await createUiSessionStatusGet(account)({ sessionId: session.id, readiness: true }))
            .toMatchObject({ ok: true, readiness: { cause: 'agent', agent: { state: 'needsSignIn', repair } } });
    } finally { account.dispose(); }
    signedIn = true; // Native acknowledgement supplied by the real inventory transport boundary.
    await act(async () => { await hook.getCurrent().refresh(); });
    await vi.waitFor(() => expect(hook.getCurrent().readiness?.status).toBe('ready'));
    expect(network.requests.some(request => request.method === 'daemon.agents.signIn.prepare')).toBe(false);
});

it('discards a late exact-Session response after the readiness detail closes', async () => {
    const home = await network.addHome('https://readiness-close.test', 'alice');
    const accountLifetime = { scope: { serverId: home.id, accountId: 'alice' }, isCurrent: () => true,
        onRetire: () => ({ dispose() {} }) };
    const gate = createDeferred<void>();
    const session = createSessionFixture({ id: 'late-bot', encryptionMode: 'plain', access: createSessionAccessFixture('view') });
    network.resetRequests();
    network.setHttpResponder(async input => {
        if (new URL(String(input)).pathname !== `/v2/sessions/${session.id}`) return null;
        await gate.promise;
        return Response.json(createPlainSessionByIdResponseFixture(session));
    });
    const hook = await renderHook(({ enabled }: { enabled: boolean }) => useSessionReadiness({ accountLifetime,
        sessionId: session.id, enabled }), { initialProps: { enabled: true } });
    await vi.waitFor(() => expect(network.httpRequests.some(request => request.url.endsWith(`/v2/sessions/${session.id}`))).toBe(true));
    await hook.rerender({ enabled: false });
    await act(async () => { gate.resolve(); });
    expect(hook.getCurrent().readiness).toBeNull();
    expect(hook.getCurrent().repair).toBeNull();
    expect(network.requests).toEqual([]);
});

it('answers a Session the Home reports missing as not found, so a picked Session needs no inventory to be refused', async () => {
    const home = await network.addHome('https://status-missing.test', 'alice');
    network.resetRequests();
    network.setHttpResponder(async input => new URL(String(input)).pathname === '/v2/sessions/gone'
        ? Response.json({ error: 'Session not found' }, { status: 404 }) : null);
    const account = await captureLazyActionAccountContext(home.id);
    try {
        expect(await createUiSessionStatusGet(account)({ sessionId: 'gone' })).toEqual({ ok: false, code: 'session_not_found' });
    } finally { account.dispose(); }
});

it('reads a Session the Action context names by the Home profile id when the captured Account scope carries the portable Home id', async () => {
    const home = await network.addHome('https://status-portable.test', 'alice');
    const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
    await setServerProfileIdentityForUrl(home.serverUrl, 'srv_status_portable');
    network.resetRequests();
    network.setHttpResponder(async input => new URL(String(input)).pathname === '/v2/sessions/gone'
        ? Response.json({ error: 'Session not found' }, { status: 404 }) : null);
    const account = await captureLazyActionAccountContext(home.id);
    try {
        expect(account.serverId).toBe('srv_status_portable');
        // The Home answers; it is not refused as another Home's Session.
        expect(await createUiSessionStatusGet(account)({ sessionId: 'gone', serverId: home.id })).toEqual({ ok: false, code: 'session_not_found' });
        expect(await createUiSessionStatusGet(account)({ sessionId: 'gone', serverId: 'another-home' })).toEqual({ ok: false, code: 'server_scope_mismatch' });
    } finally { account.dispose(); }
});
