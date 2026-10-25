import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it, vi, onTestFailed, onTestFinished } from 'vitest';
import { createMachineFixture, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createPlainPromptLibraryCatalogHomeFixture, createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptRegistrySkillFixture } from '@/dev/testkit/harness/promptMachineTransferBoundary';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { PromptBundleArtifactHeaderV1Schema, PromptBundleBodyV1Schema } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import { SkillLockV1Schema, encodeSkillRevisionV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { createUiPromptLibraryArtifactStore } from '@/sync/ops/promptLibrary/promptLibraryArtifactStore';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { listRegistrySourcesV1, projectPluginRegistrySourceDeclarationV1, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1, RegistryFetchRequestV1Schema, type RegistryFetchRequestV1, type RegistrySourceV1 } from '@happier-dev/protocol/registries';
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
import { checkRegistryUpstreamV1, type RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import { createUiRegistryHttpV1 } from './registryHttpV1';

const transport = vi.hoisted(() => ({ calls: [] as ServerScopedMachineRpcParams<RegistryFetchRequestV1>[], platform: 'web' }));
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
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
const { useSkillsLibrary } = await import('@/sync/domains/skills/useSkillsLibrary');
const { useSkillsUpdates } = await import('@/components/settings/skills/updates/useSkillsUpdates');
const { useSkillDetail } = await import('@/components/settings/skills/detail/useSkillDetail');
const { useRegistrySources } = await import('./useRegistrySources');

it.each([false, true])('previews a multi-plugin skill link with one repository read (manifest absent: %s)', async absentManifest => {
    const requests: string[] = [];
    const commit = '1'.repeat(40);
    const names = ['review', 'release', 'debug'];
    const skills = names.map(name => createPromptRegistrySkillFixture({ sourceId: 'marketplace', itemId: `plugins/${name}/skills/${name}`, title: name,
        files: [{ path: 'SKILL.md', content: `---\nname: ${name}\n---\nInstructions for ${name}` }] }));
    const fixture = await createPlainPromptLibraryCatalogHomeFixture('https://registry-link-preview.test', {
        key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] },
    }, 'updated', { handleExternalRequest: async input => {
        const url = String(input);
        requests.push(url);
        if (url.endsWith('/marketplace.json')) return Response.json({ plugins: names.map(name => ({ name, source: `./plugins/${name}` })) });
        if (url.includes('/commits/')) return Response.json({ sha: commit });
        if (url.includes('/git/trees/')) return Response.json({ sha: '2'.repeat(40), tree: skills.flatMap(fixture => {
            if (fixture.item.payload.kind !== 'skill') throw new Error('Expected canonical skill fixture');
            const skill = fixture.item.payload.skill;
            return [{ path: skill.ref.path, type: 'tree', mode: '040000', sha: skill.ref.treeSha },
                ...skill.files.map(file => ({ path: `${skill.ref.path}/${file.path}`, type: 'blob', mode: '100644', sha: file.blobSha, size: file.size }))];
        }) });
        if (url.endsWith('/plugin.json')) return absentManifest ? new Response('', { status: 404 }) : Response.json({});
        const index = names.findIndex(name => url.endsWith(`/skills/${name}/SKILL.md`));
        const payload = skills[index]?.item.payload;
        if (payload?.kind === 'skill') return new Response(payload.skill.skillMarkdown);
        throw new Error(`Unexpected external registry request: ${url}`);
    } });
    onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
    transport.calls.length = 0;
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const result = await createDefaultActionExecutor().execute('skills.install', {
        source: { kind: 'link', url: 'https://github.com/owner/market' }, dryRun: true,
    }, { surface: 'ui', authority: 'present_user', serverId: fixture.home.id });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(JSON.stringify(result));
    const preview = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.install'].parse(result.result);
    expect(preview).toMatchObject({ items: names.map(name => ({ name })) });
    expect(requests.filter(url => url.includes('/commits/'))).toHaveLength(1);
    expect(requests.filter(url => url.includes('/git/trees/'))).toHaveLength(1);
    expect(requests.filter(url => url.endsWith('/plugin.json'))).toHaveLength(names.length);
    expect(transport.calls).toEqual([]);
});

it.each([403, 429])('preserves an upstream %s quota failure during link detection or repository read without another API request', async status => {
    const requests: string[] = [];
    const fixture = await createPlainPromptLibraryCatalogHomeFixture(`https://registry-link-quota-${status}.test`, {
        key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] },
    }, 'updated', { handleExternalRequest: async url => {
        requests.push(url);
        if (status === 403 && !url.startsWith('https://api.github.com/')) return Response.json({ plugins: [
            { name: 'review', source: './plugins/review' }, { name: 'release', source: './plugins/release' },
        ] });
        return new Response('', { status, ...(status === 403 ? { headers: { 'x-ratelimit-remaining': '0' } } : {}) });
    } });
    onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
    transport.calls.length = 0;
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const result = await createDefaultActionExecutor().execute('skills.install', {
        source: { kind: 'link', url: 'https://github.com/owner/limited' }, dryRun: true,
    }, { surface: 'ui', authority: 'present_user', serverId: fixture.home.id });
    expect(result).toMatchObject({ ok: false, details: { registryStatus: { state: 'rate_limited' } } });
    if (status === 403) {
        expect(requests.filter(url => url.startsWith('https://api.github.com/')))
            .toEqual(['https://api.github.com/repos/owner/limited/commits/HEAD']);
        expect(requests.some(url => url.endsWith('/SKILL.md') || url.endsWith('/plugin.json'))).toBe(false);
    } else expect(requests).toEqual(['https://raw.githubusercontent.com/owner/limited/HEAD/.claude-plugin/marketplace.json']);
    expect(transport.calls).toEqual([]);
});

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

it('refreshes daemon-created sources in the UI and reads tokened sources through the captured requester Account', async () => {
    let phase = 'prepare requester Home';
    let listState: Readonly<{ loading: boolean; error: string | null; count: number }> | undefined;
    onTestFailed(() => console.error('FIX50 composed phase:', phase, listState));
    // The shared admission presenter is a UI boundary; accept so writes reach the requester transport.
    const { Modal } = await import('@/modal');
    const confirmation = vi.spyOn(Modal, 'confirm').mockResolvedValue(true);
    onTestFinished(() => confirmation.mockRestore());
    let upstreamFails = false;
    let allUpstreamsFail = false;
    const checkedSources: RegistrySourceDescriptorV1[] = ['healthy', '403', '429', 'unreachable'].map(id => ({
        id, title: id, format: 'git', kinds: ['skill'], url: `https://github.com/fixture/${id}`,
        enabled: true, addedAt: 0, origin: { kind: 'user' }, removable: true,
    }));
    const produceCheck = async () => {
        const http = createUiRegistryHttpV1(async url => {
            const path = String(url);
            if (allUpstreamsFail) throw new TypeError('offline');
            if (upstreamFails && path.includes('/403/')) return new Response('', { status: 403 });
            if (upstreamFails && path.includes('/429/')) return new Response('', { status: 429 });
            if (upstreamFails && path.includes('/unreachable/')) throw new TypeError('offline');
            return Response.json({ sha: '1'.repeat(40) });
        });
        const upstream = await checkRegistryUpstreamV1({ http }, { sources: checkedSources, items: checkedSources.map(source => ({
            key: source.id, provenance: { sourceId: source.id, sourceUrl: source.url, format: source.format, itemId: 'review', importedAt: 0,
                ref: { kind: 'gitTree' as const, repo: source.url, path: 'review', commit: '1'.repeat(40), treeSha: '2'.repeat(40) } },
        })) });
        return REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.updates.check'].parse({ checkedAt: upstreamFails ? 20 : 10,
            results: checkedSources.map(source => ({ kind: 'skill', key: source.id, upstream: upstream.get(source.id) })) });
    };
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
    const addedSource: RegistrySourceV1 = { ...source, id: 'daemon-created-source', title: 'New private source',
        url: 'https://github.com/requester/new-private' };
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
        if (request.path === '/v1/machines/read-batch' && request.method === 'POST') {
            // The batched read publishes the stored row; its bootstrap fields keep the installation identity.
            const { runnerClaim: _bootstrapOnly, ...publishedFields } = machineRow;
            return createMachineReadBatchResponseFixture(request.body, id => id === machineId
                ? { ...createPlainMachineRowFixture({ id: machineId, accountId: 'registry-custodian' }), ...publishedFields } : null);
        }
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
        if (actionId === 'registries.sources.create') {
            // The remote process is the boundary: commit its row through the same Home CAS protocol,
            // without sending a socket echo. The UI must revalidate on the acknowledged Action alone.
            const record = catalog.read('registry-sources');
            if (record.key !== 'registry-sources') throw new Error('Expected registry row');
            const written = await catalog.handle('/v1/account/entity-rows/prompt-library/registry-sources', {
                method: 'POST', body: JSON.stringify({ expectedRevision: catalog.revision('registry-sources'),
                    content: { t: 'plain', v: { ...record, value: { ...record.value, sources: [...record.value.sources, addedSource] } } } }),
            });
            expect(await written?.json()).toMatchObject({ status: 'updated' });
            const output = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.sources.create'].parse({ existing: false,
                source: listRegistrySourcesV1({ record: { ...record.value, sources: [addedSource] }, pluginSources: [] })
                    .find(candidate => candidate.id === addedSource.id) });
            return Response.json({ v: 1, actionId, requestId: envelope.requestId, execution: { ok: true, result: output } });
        }
        if (actionId.startsWith('skills.') || actionId === 'prompt_registry.install') {
            const response = ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId, requestId: envelope.requestId,
                execution: remoteExecution ?? { ok: false, errorCode: 'origin_probe_refused', error: 'origin_probe_refused' } });
            afterRemoteAck?.();
            return Response.json(response);
        }
        const result = actionId === 'registries.updates.check' ? await produceCheck()
            : actionId === 'registries.items.list' ? { pages: [{ sourceId: source.id, status: { state: 'ok', fetchedAt: 1 }, items: [], nextCursor: null }] }
            : { item: { summary: { sourceId: source.id, kind: 'skill', itemId: 'private-skill', title: 'Requester skill', version: '1'.repeat(40) },
                payload: { kind: 'skill', skill: { ref: { kind: 'gitTree', repo: source.url, path: '', commit: '1'.repeat(40), treeSha: '2'.repeat(40) },
                    skillMarkdown: '---\nname: requester-skill\n---\nPrivate content', files: [] } }, fetchedAt: 1 } };
        return Response.json({ v: 1, actionId, requestId: envelope.requestId, execution: { ok: true, result } });
    } });
    onTestFinished(() => homes.dispose());
    setRuntimeFetch(async (input, init) => {
        const url = String(input);
        if (url === DEFAULT_CURATED_MARKETPLACE_SOURCE_URL) return new Response(null, { status: 503 });
        return homes.fetch(input, init);
    });
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
    phase = 'mount UI source list';
    const sourceList = await renderHook(() => {
        const value = useRegistrySources('skill');
        listState = { loading: value.loading, error: value.error, count: value.sources.length };
        return value;
    });
    phase = 'wait for initial UI source list';
    await waitForHomeGovernance(() => expect(sourceList.getCurrent().sources.some(candidate => candidate.id === source.id)).toBe(true));
    const beforeCreate = catalog.revision('registry-sources');
    phase = 'execute daemon create and acknowledge catalog invalidation';
    await act(async () => { await host.execute('registries.sources.create', {
        url: addedSource.url, token: addedSource.token,
    }); });
    expect(catalog.revision('registry-sources')).toBe(beforeCreate + 1);
    phase = 'wait for daemon-created source in mounted UI list';
    await waitForHomeGovernance(() => expect(sourceList.getCurrent().sources.some(candidate => candidate.id === addedSource.id)).toBe(true));
    expect(actionCalls).toEqual(['registries.sources.create']);
    actionCalls.length = 0;
    phase = 'existing requester private-read corridor';
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
    expect(checked.results).toHaveLength(4);
    expect(checked.results.every(item => item.upstream.state === 'current')).toBe(true);
    expect(actionCalls.at(-1)).toBe('registries.updates.check');
    expect(transport.calls).toEqual([]);
    const fixture = createPromptRegistrySkillFixture({ sourceId: source.id, itemId: 'private-skill', title: 'Requester skill',
        files: [{ path: 'SKILL.md', content: '---\nname: requester-skill\n---\nPrivate content' }] });
    const store = createUiPromptLibraryArtifactStore(account.workflowArtifacts, account);
    const created = await store.create!({ header: PromptBundleArtifactHeaderV1Schema.parse({ v: 1, kind: 'prompt_bundle.v2',
        title: 'Requester skill', bundleSchemaId: 'skills.skill_md_v1', skillLock: SkillLockV1Schema.parse({ updatePolicy: 'manual',
            upstream: { state: 'update_available', latest: fixture.item.payload.kind === 'skill' ? fixture.item.payload.skill.ref : undefined },
            provenance: { kind: 'registry', registry: { sourceId: source.id, format: source.format, sourceUrl: source.url, importedAt: 0,
                itemId: 'private-skill', ref: fixture.item.payload.kind === 'skill'
                ? fixture.item.payload.skill.ref : undefined } } }) }),
        body: JSON.stringify(PromptBundleBodyV1Schema.parse({ v: 1, createdAtMs: 0, updatedAtMs: 0,
            entries: fixture.files.map(file => ({ ...file, contentKind: 'utf8' })) })) });
    const skillId = typeof created === 'string' ? created : created.artifactId;
    const expectedRevision = typeof created === 'string' ? '1:1' : encodeSkillRevisionV1(created.revision);
    onTestFinished(() => storage.getState().deleteArtifact(skillId));
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const executor = createDefaultActionExecutor();
    for (const [actionId, input] of [
        ['skills.install', { source: { kind: 'registry', sourceId: source.id, itemId: 'private-skill', version: '1'.repeat(40) }, dryRun: true }],
        ['skills.updates.diff', { skillId }],
        ['skills.updates.apply', { skillId, expectedRevision }],
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
    const updates = await renderHook(() => useSkillsUpdates(useSkillsLibrary()));
    const detail = await renderHook(() => useSkillDetail(skillId));
    await waitForHomeGovernance(() => expect(updates.getCurrent().ready).toBe(true));
    await act(async () => { await updates.getCurrent().checkNow(); });
    expect(updates.getCurrent().check).toMatchObject({ failed: false, checkedAt: 10 });
    upstreamFails = true;
    await act(async () => { await updates.getCurrent().checkNow(); });
    expect(updates.getCurrent().check).toMatchObject({ failed: true, checkedAt: 10, results: [
        { key: 'healthy', upstream: { state: 'current' } },
        { key: '403', upstream: { state: 'unchecked', reason: { state: 'auth_failed' } } },
        { key: '429', upstream: { state: 'unchecked', reason: { state: 'rate_limited' } } },
        { key: 'unreachable', upstream: { state: 'unchecked', reason: { state: 'unreachable' } } },
    ] });
    expect(artifacts.readPlainBody(skillId)).toBe(JSON.stringify(PromptBundleBodyV1Schema.parse({ v: 1, createdAtMs: 0, updatedAtMs: 0,
        entries: fixture.files.map(file => ({ ...file, contentKind: 'utf8' })) })));
    await act(async () => { await detail.getCurrent().checkNow(); });
    expect(detail.getCurrent().checkFailed).toBe(true);
    allUpstreamsFail = true;
    await act(async () => { await updates.getCurrent().checkNow(); await detail.getCurrent().checkNow(); });
    expect(updates.getCurrent().check).toMatchObject({ failed: true, checkedAt: 10 });
    expect(updates.getCurrent().check.results).toHaveLength(4);
    expect(updates.getCurrent().check.results.every(item => item.upstream.state === 'unchecked')).toBe(true);
    expect(detail.getCurrent().checkFailed).toBe(true);
    allUpstreamsFail = false;
    upstreamFails = false;
    await act(async () => { await updates.getCurrent().checkNow(); await detail.getCurrent().checkNow(); });
    expect(updates.getCurrent().check.failed).toBe(false);
    expect(detail.getCurrent().checkFailed).toBe(false);
    await updates.unmount();
    await detail.unmount();
    await sourceList.unmount();
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
        const selectedMachine = createMachineFixture({ id: 'zz-explicit-registry-machine', createdAt: machine.createdAt - 1, activeAt: Date.now() });
        storage.setState({ machines: { [machine.id]: machine, [selectedMachine.id]: selectedMachine },
            machineListByServerId: { ...previousMachines, [account.serverId]: [machine, selectedMachine] } });
        const targeted = await createUiRegistryHostV1(account, port, {
            externalActionTarget: { kind: 'machine', machineId: selectedMachine.id },
        });
        const defaultRead = { kind: 'skill' as const, sourceIds: ['native-other-git'] };
        await host.execute('registries.items.list', defaultRead);
        const targetedOutput = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(
            await targeted.execute('registries.items.list', defaultRead));
        expect(targetedOutput.pages[0]?.machineId).toBe(selectedMachine.id);
        expect(transport.calls.at(-1)?.machineId).toBe(selectedMachine.id);
        storage.setState({ machines: { [machine.id]: machine },
            machineListByServerId: { ...previousMachines, [account.serverId]: [machine] } });
        const missingTarget = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(
            await targeted.execute('registries.items.list', { ...defaultRead, refresh: true }));
        expect(missingTarget.pages[0]?.status.state).toBe('needs_machine');
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
