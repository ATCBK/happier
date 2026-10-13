import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it, vi, onTestFailed, onTestFinished } from 'vitest';
import { createMachineFixture, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createPlainPromptLibraryCatalogHomeFixture, createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptRegistrySkillFixture } from '@/dev/testkit/harness/promptMachineTransferBoundary';
import { PromptBundleArtifactHeaderV1Schema, PromptBundleBodyV1Schema } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import { SkillLockV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { createUiPromptLibraryArtifactStore } from '@/sync/ops/promptLibrary/promptLibraryArtifactStore';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { projectPluginRegistrySourceDeclarationV1, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1, RegistryFetchRequestV1Schema, type RegistryFetchRequestV1, type RegistrySourceV1 } from '@happier-dev/protocol/registries';
import type { ServerScopedMachineRpcParams } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';
import nacl from 'tweetnacl';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ExternalActionRequestEnvelopeV1Schema, ExternalActionExecutionAuthorizationV1Schema, ExternalActionMachineBootstrapV1Schema,
    ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { DEFAULT_CURATED_MARKETPLACE_SOURCE_URL } from '@happier-dev/protocol/marketplace';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';

const transport = vi.hoisted(() => ({ calls: [] as ServerScopedMachineRpcParams<RegistryFetchRequestV1>[], platform: 'web' }));
// Machine RPC leaves this process; source ownership, supplier selection and REACH stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async (request: ServerScopedMachineRpcParams<RegistryFetchRequestV1>) => {
        transport.calls.push(request);
        const input = RegistryFetchRequestV1Schema.parse(request.payload);
        if (input.op !== 'list') throw new Error('Fixture serves registry lists');
        return { op: 'list', page: { sourceId: input.sourceId, status: { state: 'ok', fetchedAt: 1 }, items: [], nextCursor: null } };
    },
}));
vi.mock('react-native', async () => {
    return (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
        Platform: { get OS() { return transport.platform; } },
    });
});
installDisconnectedServerSocketBoundary();

// Compile the real production graph after transport installation and before the
// interaction budget, as the canonical Home/Action composed harnesses do.
const { storage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { normalizePluginInstalledUiDeclarations } = await import('@/sync/domains/plugins/ui/projection');
const { unionPluginUiProjections } = await import('@/sync/domains/plugins/ui/projectionUnion');
const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const { createConnectedAccountDescriptorProjectionLoadingState } = await import('@/sync/domains/connectedServices/connectedAccountDescriptorProjection');
const { createUiRegistryHostV1 } = await import('./registryHostDeps');
const { recordMachineRequestFailed, clearMachineRequestReachabilityForTest } = await import('@/sync/domains/machines/reachability/machineReachability');
const { readCurrentAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const { useRegistrySuggestions } = await import('./useRegistrySuggestions');
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');

it('opens an empty web skill recommendation shelf without a daemon browse even with a reachable Machine', async () => {
    const fixture = await createPlainPromptLibraryCatalogHomeFixture('https://registry-homepage-direct.test', {
        key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] },
    }, 'updated', { handleExternalRequest: async () => new Response(null, { status: 503 }) });
    onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
    const machine = createMachineFixture({ id: 'homepage-online', activeAt: Date.now() });
    storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [fixture.home.id]: [machine] } });
    const before = transport.calls.length;
    const hook = await renderHook(() => useRegistrySuggestions('skill'));
    await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
    expect(hook.getCurrent()).toMatchObject({ items: [], sourceId: null });
    expect(transport.calls.length).toBe(before);
});

it('reads a tokened source on a shared Machine through the captured requester Account rather than raw custodian RPC', async () => {
    const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19));
    const machineId = 'shared-registry-machine';
    const installationId = 'shared-registry-installation';
    const homeIdentityId = 'srv_registry_requester_home';
    const machineRow = { ...ExternalActionMachineBootstrapV1Schema.parse({ id: machineId, kind: 'persistent', active: true,
        installationId, revokedAt: null, replacedByMachineId: null, dataEncryptionKey: null, runnerContentKeyBinding: null,
        access: { custodian: { accountId: 'registry-custodian', displayName: 'Custodian' }, role: 'use', resourceMode: 'plain', accessState: 'ready' } }),
        installationPublicKey: encodeBase64(installation.publicKey) };
    const source: RegistrySourceV1 = { id: 'private-requester-source', title: 'Private requester source', format: 'git',
        kinds: ['skill'], url: 'https://github.com/requester/private', enabled: true, addedAt: 0,
        token: { secretRef: 'happier:shared-secret:v1:requester-secret' } };
    const actionCalls: string[] = [];
    let remoteExecution: ActionExecuteResult | null = null;
    let afterRemoteAck: (() => void) | undefined;
    const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'registry-requester', encryptionMode: 'plain' });
    const catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'registry-sources',
        value: { v: 2, sources: [source], disabledSourceIds: [] } }] });
    const homes = await serveAccountHomes({ homes: [{ key: 'home', serverUrl: 'https://registry-requester.example.test',
        accountId: 'registry-requester', currentAccount: true }], route: async request => {
        const artifactResponse = artifacts.handle(request.path, { method: request.method,
            ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) });
        if (artifactResponse) return await artifactResponse;
        const catalogResponse = await catalog.handle(request.path, { method: request.method, headers: request.headers,
            ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) });
        if (catalogResponse) return catalogResponse;
        if (request.path === '/v1/machines') return Response.json([machineRow]);
        if (!request.path.startsWith('/v1/actions/')) return undefined;
        expect(request.accountId).toBe('registry-requester');
        const body = request.body as Readonly<{ envelope: unknown; executionAuthorization?: unknown }>;
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body.envelope);
        const actionId = request.path.split('/')[3]!;
        if (request.path.endsWith('/execution-authorization')) return Response.json(ExternalActionExecutionAuthorizationV1Schema.parse({
            v: 1, token: 'home-signed-requester', binding: { accountId: request.accountId, authentication: { kind: 'account', tokenEpoch: 0 },
                serverIdentityId: homeIdentityId, machineId, installationId, custodianAccountId: 'registry-custodian', accountEncryptionMode: 'plain',
                actionId, requestId: envelope.requestId, target: envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) },
        }));
        expect(openExternalActionRequesterAccountContextV1({ authorization: body.executionAuthorization,
            purpose: { kind: 'external_action' }, machineId, installationId, serverIdentityId: homeIdentityId,
            installationPrivateKey: installation.secretKey })).toMatchObject({ token: expect.any(String) });
        actionCalls.push(actionId);
        if (actionId.startsWith('skills.') || actionId === 'prompt_registry.install') {
            const response = ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId, requestId: envelope.requestId,
                execution: remoteExecution ?? { ok: false, errorCode: 'origin_probe_refused', error: 'origin_probe_refused' } });
            afterRemoteAck?.();
            return Response.json(response);
        }
        const result = actionId === 'registries.updates.check' ? { checkedAt: 10, results: [{ kind: 'skill', key: 'tracked-private-skill',
            upstream: { state: 'unchecked', reason: { state: 'rate_limited' } } }] }
            : actionId === 'registries.items.list' ? { pages: [{ sourceId: source.id, status: { state: 'ok', fetchedAt: 1 }, items: [], nextCursor: null }] }
            : { item: { summary: { sourceId: source.id, kind: 'skill', itemId: 'private-skill', title: 'Requester skill', version: '1'.repeat(40) },
                payload: { kind: 'skill', skill: { ref: { kind: 'gitTree', repo: source.url, path: '', commit: '1'.repeat(40), treeSha: '2'.repeat(40) },
                    skillMarkdown: '---\nname: requester-skill\n---\nPrivate content', files: [] } }, fetchedAt: 1 } };
        return Response.json({ v: 1, actionId, requestId: envelope.requestId, execution: { ok: true, result } });
    } });
    onTestFinished(() => homes.dispose());
    const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
    await setServerProfileIdentityForUrl(homes.homes.home!.serverUrl, homeIdentityId);
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const account = await captureLazyActionAccountContext(homes.homes.home!.id);
    expect(account.serverIdentityId).toBe(homeIdentityId);
    // A scoped echo does not activate a different scope. Identity adoption
    // must activate the canonical Home scope before publishing its Settings.
    await storage.getState().activateSettingsScope({ serverId: account.serverId, accountId: account.accountId });
    storage.getState().applySettingsForScope({ serverId: account.serverId, accountId: account.accountId }, storage.getState().settings, 1);
    onTestFinished(() => account.dispose());
    const previous = storage.getState().machineListByServerId;
    const machines = storage.getState().machines;
    const machine = createMachineFixture({ id: machineId, activeAt: Date.now() });
    storage.setState({ machines: { [machineId]: machine }, machineListByServerId: { ...previous, [account.serverId]: [machine] } });
    onTestFinished(() => storage.setState({ machines, machineListByServerId: previous }));
    const port = createUiPromptLibraryArtifactStore(account.workflowArtifacts, account).organization;
    if (!port) throw new Error('Canonical prompt-library store must expose its organization port');
    const baseline = await port.readCatalog(undefined, 'registry-sources');
    expect(baseline.catalog).toMatchObject({ status: 'ready' });
    transport.calls.length = 0;
    const host = await createUiRegistryHostV1(account, port, { surface: 'ui', authority: 'present_user',
        actionCaller: { kind: 'host' }, actionRequestId: 'requester-registry-read' });
    expect(REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list',
        { kind: 'skill', sourceIds: [source.id], refresh: true })).pages[0]).toMatchObject({ sourceId: source.id, machineId });
    expect(actionCalls).toEqual(['registries.items.list']);
    expect(transport.calls).toEqual([]);
    expect(REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await host.execute('registries.items.read',
        { kind: 'skill', sourceId: source.id, itemId: 'private-skill', version: '1'.repeat(40) })).item.summary.title).toBe('Requester skill');
    expect(actionCalls).toEqual(['registries.items.list', 'registries.items.read']);
    expect(transport.calls).toEqual([]);
    const checked = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.updates.check'].parse(await host.execute('registries.updates.check', {
        kind: 'skill', keys: ['tracked-private-skill'],
    }));
    expect(checked.results).toEqual([{ kind: 'skill', key: 'tracked-private-skill', upstream: { state: 'unchecked', reason: { state: 'rate_limited' } } }]);
    expect(actionCalls.at(-1)).toBe('registries.updates.check');
    expect(transport.calls).toEqual([]);
    const fixture = createPromptRegistrySkillFixture({ sourceId: source.id, itemId: 'private-skill', title: 'Requester skill',
        files: [{ path: 'SKILL.md', content: '---\nname: requester-skill\n---\nPrivate content' }] });
    const store = createUiPromptLibraryArtifactStore(account.workflowArtifacts, account);
    const skillId = await store.create!({ header: PromptBundleArtifactHeaderV1Schema.parse({ v: 1, kind: 'prompt_bundle.v2',
        title: 'Requester skill', bundleSchemaId: 'skills.skill_md_v1', skillLock: SkillLockV1Schema.parse({ updatePolicy: 'manual',
            upstream: { state: 'update_available', latest: fixture.item.payload.kind === 'skill' ? fixture.item.payload.skill.ref : undefined },
            provenance: { kind: 'registry', registry: { sourceId: source.id, format: source.format, sourceUrl: source.url, importedAt: 0,
                itemId: 'private-skill', ref: fixture.item.payload.kind === 'skill'
                ? fixture.item.payload.skill.ref : undefined } } }) }),
        body: JSON.stringify(PromptBundleBodyV1Schema.parse({ v: 1, createdAtMs: 0, updatedAtMs: 0,
            entries: fixture.files.map(file => ({ ...file, contentKind: 'utf8' })) })) });
    onTestFinished(() => storage.getState().deleteArtifact(skillId));
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const executor = createDefaultActionExecutor();
    for (const [actionId, input] of [
        ['skills.install', { source: { kind: 'registry', sourceId: source.id, itemId: 'private-skill', version: '1'.repeat(40) }, dryRun: true }],
        ['skills.updates.diff', { skillId }],
        ['skills.updates.apply', { skillId, expectedRevision: '1:1' }],
        ['prompt_registry.install', { machineId, sourceId: source.id, itemId: 'private-skill' }],
    ] as const) {
        expect.soft(await executor.execute(actionId, input, { surface: 'ui', authority: 'present_user', serverId: account.serverId }))
            .toEqual({ ok: false, errorCode: 'origin_probe_refused', error: 'origin_probe_refused' });
        expect.soft(actionCalls.at(-1)).toBe(actionId);
    }
    expect(artifacts.list()).toHaveLength(1);
    expect(transport.calls).toEqual([]);
    const installInput = { source: { kind: 'registry', sourceId: source.id, itemId: 'private-skill', version: '1'.repeat(40) } } as const;
    remoteExecution = { ok: true, result: SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.install'].parse({ skillIds: [skillId], includedInSessionId: null }) };
    expect(storage.getState().settingsScope).toEqual({ serverId: account.serverId, accountId: account.accountId });
    await account.fetchArtifact(skillId);
    expect(storage.getState().artifacts[skillId]?.body).toBe(artifacts.readPlainBody(skillId));
    storage.getState().deleteArtifact(skillId);
    expect(await executor.execute('skills.install', installInput, { surface: 'ui', serverId: account.serverId }))
        .toEqual(remoteExecution);
    expect(storage.getState().artifacts[skillId]?.body).toBe(artifacts.readPlainBody(skillId));
    const cancelledAfterAck = new AbortController();
    afterRemoteAck = () => cancelledAfterAck.abort();
    expect(await executor.execute('skills.install', installInput, { surface: 'ui', serverId: account.serverId, signal: cancelledAfterAck.signal }))
        .toEqual(remoteExecution);
    const cancelledPreview = new AbortController();
    afterRemoteAck = () => cancelledPreview.abort();
    remoteExecution = { ok: true, result: SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.install'].parse({ items: [] }) };
    const preview = await executor.execute('skills.install', { ...installInput, dryRun: true },
        { surface: 'ui', serverId: account.serverId, signal: cancelledPreview.signal }).then(
            result => ({ kind: 'returned' as const, result }), error => ({ kind: 'rejected' as const, error }));
    if (preview.kind === 'returned') expect(preview.result.ok).toBe(false);
    else expect(preview.error).toMatchObject({ name: 'AbortError' });
    expect(artifacts.list()).toHaveLength(1);
    expect(transport.calls).toEqual([]);
});

it('routes native non-GitHub Git through the captured Account Machine transport while keeping public GitHub direct', async () => {
    transport.platform = 'ios';
    const sources: RegistrySourceV1[] = [
        { id: 'native-other-git', title: 'Other Git', format: 'git', kinds: ['skill'], url: 'https://git.example.test/a/b.git', enabled: true, addedAt: 0 },
        { id: 'native-github', title: 'GitHub', format: 'git', kinds: ['skill'], url: 'https://github.com/a/b', enabled: true, addedAt: 0 },
    ];
    const catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'registry-sources', value: { v: 2, sources, disabledSourceIds: [] } }] });
    const homes = await serveAccountHomes({ homes: [{ key: 'home', serverUrl: 'https://registry-native.example.test', accountId: 'native-registry-account' }],
        route: async request => await catalog.handle(request.path, { method: request.method, headers: request.headers,
            body: request.body === undefined ? undefined : JSON.stringify(request.body) }) ?? undefined });
    onTestFinished(async () => { try { await homes.dispose(); } finally { transport.platform = 'web'; } });
    onTestFailed(() => console.error('Native registry Home requests:', JSON.stringify(homes.requests.map(request => ({ path: request.path, method: request.method })))));
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const account = await captureLazyActionAccountContext(homes.homes.home!.id);
    onTestFinished(() => account.dispose());
    const previousMachines = storage.getState().machineListByServerId;
    const previousActiveMachines = storage.getState().machines;
    const machine = createMachineFixture({ id: 'native-git-machine', activeAt: Date.now() });
    storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { ...previousMachines, [account.serverId]: [machine] } });
    const port = createUiPromptLibraryArtifactStore(account.workflowArtifacts, account).organization!;
    transport.calls.length = 0;
    setRuntimeFetch(async (url, init) => new URL(String(url)).origin === new URL(homes.homes.home!.serverUrl).origin
        ? homes.fetch(url, init)
        : Response.json(String(url).includes('/commits/') ? { sha: '1'.repeat(40) } : { sha: '2'.repeat(40), tree: [] }));
    try {
        const host = await createUiRegistryHostV1(account, port, {});
        const output = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list', {
            kind: 'skill', sourceIds: ['native-other-git', 'native-github'], refresh: true,
        }));
        expect(output.pages.map(page => ({ sourceId: page.sourceId, state: page.status.state, machineId: page.machineId })))
            .toEqual([{ sourceId: 'native-other-git', state: 'ok', machineId: machine.id }, { sourceId: 'native-github', state: 'ok', machineId: undefined }]);
        expect(transport.calls.map(call => ({ machineId: call.machineId, serverId: call.serverId, accountId: call.accountId, method: call.method, payload: call.payload })))
            .toEqual([{ machineId: machine.id, serverId: account.serverId, accountId: account.accountId, method: 'daemon.registries.fetch',
                payload: { op: 'list', kind: 'skill', sourceId: 'native-other-git' } }]);
        storage.setState({ machines: {}, machineListByServerId: { ...previousMachines, [account.serverId]: [] } });
        const offline = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list', {
            kind: 'skill', sourceIds: ['native-other-git', 'native-github'], refresh: true,
        }));
        expect(offline.pages.map(page => ({ sourceId: page.sourceId, state: page.status.state })))
            .toEqual([{ sourceId: 'native-other-git', state: 'needs_machine' }, { sourceId: 'native-github', state: 'ok' }]);
    } finally {
        storage.setState({ machines: previousActiveMachines, machineListByServerId: previousMachines });
        clearMachineRequestReachabilityForTest();
    }
});

it('reads same-Account offline declarations, routes only to suppliers, retries unreachable suppliers, and retires sources and cached pages', async () => {
    let phase = 'Home credential fixture';
    onTestFailed(() => { console.error(`Registry source composed failure phase: ${phase}`); });
    const catalog = createPromptLibraryCatalogBoundary();
    const homes = await serveAccountHomes({ homes: [{ key: 'home', serverUrl: 'https://registry-suppliers.example.test', accountId: 'registry-account' }],
        route: async request => await catalog.handle(request.path, { method: request.method, headers: request.headers,
            body: request.body === undefined ? undefined : JSON.stringify(request.body) }) ?? undefined });
    setRuntimeFetch(async (url, init) => String(url) === DEFAULT_CURATED_MARKETPLACE_SOURCE_URL
        ? new Response(null, { status: 503 }) : homes.fetch(url, init));
    onTestFinished(() => homes.dispose());
    phase = 'captured Account';
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const account = await captureLazyActionAccountContext(homes.homes.home!.id);
    onTestFinished(() => account.dispose());
    phase = 'declaration and AppShell owners';
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Fixture Account lifetime must be applied');
    const pluginId = 'com.acme.sources';
    const entry = projectPluginRegistrySourceDeclarationV1({ pluginId, pluginVersion: '1.0.0', definition: {
        id: 'team', title: 'Team skills', format: 'git', kinds: ['skill'], url: 'https://git.example.test/skills',
    } });
    const model = normalizePluginInstalledUiDeclarations({}, undefined, { id: pluginId, displayName: 'Acme', version: '1.0.0',
        enabled: true, source: { kind: 'path', locator: '/plugins/acme' } }, [entry]);
    let projected = unionPluginUiProjections([{ machineId: 'supplier-a', serverId: account.serverId, phase: 'retainedOffline',
        interactionEnabled: false, projection: model }]).pluginUiProjection;
    expect(projected?.registrySourcesById[entry.id]).toBeDefined();
    const value = () => ({ pluginUiProjection: projected, pluginBrowserProjection: null, phase: 'retainedOffline' as const,
        interactionEnabled: false, machineId: 'supplier-a', serverId: account.serverId, platform: 'web' as const,
        accountLifetime: lifetime, reloadConnectedAccountProjection: () => {},
        connectedAccountProjectionState: createConnectedAccountDescriptorProjectionLoadingState('fixture'),
        clientExecutableActivation: { status: 'ready' as const }, reloadClientExecutables: () => {} });
    const content = () => React.createElement(AppShellPluginUiProjectionValueProvider, { value: value(), children: null });
    phase = 'committed declaration publisher';
    const screen = await renderScreen(content());
    expect(lifetime.isCurrent()).toBe(true);
    expect(readCurrentAppShellPluginUiProjection()).toBeNull();
    expect(readCurrentAppShellPluginUiProjection({ scope: account, declarationsOnly: true })?.registrySourcesById[entry.id]).toBeDefined();
    expect(readCurrentAppShellPluginUiProjection({ scope: { serverId: account.serverId, accountId: 'another-account' }, declarationsOnly: true })).toBeNull();
    const previousMachines = storage.getState().machineListByServerId;
    const previousActiveMachines = storage.getState().machines;
    const machines = [
        createMachineFixture({ id: 'supplier-a', activeAt: Date.now() }), createMachineFixture({ id: 'general-b', activeAt: Date.now(), createdAt: 10 }),
    ];
    storage.setState({ machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
        machineListByServerId: { ...previousMachines, [account.serverId]: machines } });
    const port = createUiPromptLibraryArtifactStore(account.workflowArtifacts, account).organization!;
    transport.calls.length = 0;
    try {
        phase = 'registry source list and supplier route';
        const host = await createUiRegistryHostV1(account, port, {});
        const sources = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.sources.list'].parse(await host.execute('registries.sources.list', { kind: 'skill' }));
        expect(sources.sources.find(source => source.id === entry.id)?.origin).toEqual({ kind: 'plugin', pluginId, localId: 'team', suppliers: ['supplier-a'] });
        const input = { kind: 'skill', sourceIds: [entry.id], refresh: true };
        const page = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list', input));
        expect(page.pages[0]?.machineId).toBe('supplier-a');
        expect(transport.calls[0]?.machineId).toBe('supplier-a');
        expect(transport.calls[0]?.payload).toEqual({ op: 'list', kind: 'skill', sourceId: entry.id });
        recordMachineRequestFailed({ serverId: account.serverId, accountId: account.accountId, machineId: 'supplier-a' });
        phase = 'unreachable supplier and explicit retry';
        expect(REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list', input)).pages[0]?.status)
            .toEqual({ state: 'needs_machine' });
        const retry = await createUiRegistryHostV1(account, port, {}, { explicitRefresh: true });
        expect(REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await retry.execute('registries.items.list', input)).pages[0]?.status.state).toBe('ok');
        expect(transport.calls.at(-1)?.machineId).toBe('supplier-a');
        const publicModel = normalizePluginInstalledUiDeclarations({}, undefined, model.installedPackagesById[pluginId], [
            projectPluginRegistrySourceDeclarationV1({ pluginId, pluginVersion: '1.0.0', definition: {
                ...entry.definition, url: 'https://github.com/acme/skills',
            } }),
        ]);
        projected = unionPluginUiProjections([{ machineId: 'supplier-a', serverId: account.serverId, phase: 'retainedOffline',
            interactionEnabled: false, projection: publicModel }]).pluginUiProjection;
        await act(async () => { screen.tree.update(content()); });
        storage.setState({ machines: {}, machineListByServerId: { ...previousMachines, [account.serverId]: [] } });
        setRuntimeFetch(async (url, init) => String(url) === DEFAULT_CURATED_MARKETPLACE_SOURCE_URL
            ? new Response(null, { status: 503 }) : new URL(String(url)).origin === new URL(homes.homes.home!.serverUrl).origin
            ? homes.fetch(url, init)
            : Response.json(String(url).includes('/commits/') ? { sha: '1'.repeat(40) } : { sha: '2'.repeat(40), tree: [] }));
        const callsBeforeDirect = transport.calls.length;
        phase = 'public Git source without any online supplier';
        expect(REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list', input)).pages[0]?.status.state).toBe('ok');
        expect(transport.calls.length).toBe(callsBeforeDirect);
        projected = unionPluginUiProjections([]).pluginUiProjection;
        phase = 'supplier retirement and memo withdrawal';
        await act(async () => { screen.tree.update(content()); });
        expect(REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.sources.list'].parse(await host.execute('registries.sources.list', { kind: 'skill' })).sources.some(source => source.id === entry.id)).toBe(false);
        expect(REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list', { kind: 'skill', sourceIds: [entry.id] })).pages).toEqual([]);
        await homes.switchAccount('home', 'another-account');
        phase = 'Account retirement';
        expect(readCurrentAppShellPluginUiProjection({ scope: account, declarationsOnly: true })).toBeNull();
        await expect(host.execute('registries.sources.list', {})).rejects.toThrow();
    } finally {
        clearMachineRequestReachabilityForTest();
        storage.setState({ machines: previousActiveMachines, machineListByServerId: previousMachines });
        await act(async () => { screen.tree.unmount(); });
    }
});
