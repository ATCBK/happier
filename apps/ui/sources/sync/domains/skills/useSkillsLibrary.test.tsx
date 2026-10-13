import { afterEach, expect, it, vi } from 'vitest';
import { act, createDeferred, createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { PromptBundleArtifactHeaderV1Schema, PromptBundleBodyV1Schema } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';

installDisconnectedServerSocketBoundary();
// A native inventory scan is the Machine transport boundary, never a library prerequisite.
const nativeScan = vi.hoisted(() => vi.fn<(input: unknown) => Promise<unknown>>());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: nativeScan }));
const { storage } = await import('@/sync/domains/state/storage');
const { resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const { getPromptLibraryCatalogValue, resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { useSkillsLibrary } = await import('./useSkillsLibrary');
const { useSkillsFirstRun } = await import('@/components/settings/skills/firstRun/useSkillsFirstRun');
const { useReachProjection } = await import('@/sync/domains/capabilities/reach/useReachProjection');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { adoptHomeProfile } = await import('@/sync/domains/server/serverProfiles');
const { SkillFoundListResultV1Schema, SKILL_ACTION_OUTPUT_SCHEMAS_V1 } = await import('@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1');

afterEach(() => {
    standardCleanup();
    resetPromptLibraryCatalogEngineForTests();
    resetPromptLibraryCatalogSnapshotsForTests();
});

it('publishes the rail library and rules while native inventory is pending, then fills Machine facts without rereading the library', async () => {
    const catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'skill-rules', value: { v: 1, rules: [
        { id: 'first-party:happier:happier', skillId: 'happier:happier', target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 },
    ] } }] });
    let libraryReads = 0;
    const home = await createPlainArtifactHomeFixture('https://skills-pending-native.test', {
        serverFeatures: createRootLayoutFeaturesResponse(),
        handleRequest: async (path, init) => {
            if (path.split('?')[0] === '/v1/artifacts' && (init?.method ?? 'GET') === 'GET') libraryReads++;
            return path === '/v2/account/settings/history' ? Response.json({ snapshots: [] }) : catalog.handle(path, init);
        },
    });
    const qualifiedHome = await adoptHomeProfile({ source: 'manual', descriptor: { v: 1, homeServerIdentityId: 'srv_skills_pending_native',
        canonicalServerUrl: 'https://skills-pending-native.test', revision: 1,
        endpoints: [{ kind: 'https', url: 'https://skills-pending-native.test' }] } });
    if (!qualifiedHome.serverIdentityId) throw new Error('Expected qualified Home');
    const scope = { serverId: qualifiedHome.serverIdentityId, accountId: 'artifact-account' };
    const deferred = createDeferred<unknown>();
    nativeScan.mockReset(); nativeScan.mockReturnValue(deferred.promise);
    let scanSettled = false;
    const scan = createDefaultActionExecutor().execute('skills.found.list', { machineId: 'native-machine' }, {
        serverId: scope.serverId, surface: 'ui', authority: 'present_user',
    }).finally(() => { scanSettled = true; });
    storage.setState({ settingsScope: scope, profileScope: scope, isDataReady: true, artifactsLoaded: false, machines: {},
        machineListByServerId: { [scope.serverId]: [] }, machineListStatusByServerId: { [scope.serverId]: 'loading' } });
    const hook = await renderHook(() => ({ library: useSkillsLibrary(), reach: useReachProjection('skill', 'happier:happier') }));
    try {
        await vi.waitFor(() => expect(nativeScan).toHaveBeenCalled());
        await vi.waitFor(() => expect(hook.getCurrent().library.status).toBe('ready'), { timeout: 10_000 });
        expect(scanSettled).toBe(false);
        expect(hook.getCurrent().library.items).toMatchObject([{ skillId: 'happier:happier', rules: [{ enabled: true }] }]);
        expect(hook.getCurrent().reach).toEqual([]);
        const rows = hook.getCurrent().library.items;
        const readsBeforeMachine = libraryReads;
        const machine = createMachineFixture({ id: 'native-machine', active: true, activeAt: Date.now() });
        machine.metadata = { ...machine.metadata!, platform: 'linux', agentInventory: { checkedAt: 2, installedAgentIds: ['codex'] } };
        await act(async () => storage.setState({ machines: { [machine.id]: machine },
            machineListByServerId: { [scope.serverId]: [machine] }, machineListStatusByServerId: { [scope.serverId]: 'idle' } }));
        await vi.waitFor(() => expect(hook.getCurrent().reach).toMatchObject([{ machineId: machine.id, agents: [{ agentId: 'codex', enabled: true }] }]));
        expect(hook.getCurrent().library.items).toBe(rows);
        expect(libraryReads).toBe(readsBeforeMachine);
        const producer = SkillFoundListResultV1Schema.parse({ scannedAt: 123, roots: [], items: [] });
        deferred.resolve(producer);
        expect(await scan).toMatchObject({ ok: true });
        SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.found.list'].parse(producer);
    } finally {
        deferred.resolve(SkillFoundListResultV1Schema.parse({ scannedAt: 123, roots: [], items: [] }));
        await scan;
        await hook.unmount(); await home.dispose();
    }
});

it('shares the real library read across simultaneous rail and detail observers', async () => {
    let inventories = 0;
    const catalog = createPromptLibraryCatalogBoundary();
    const home = await createPlainArtifactHomeFixture('https://skills-observers.test', {
        serverFeatures: createRootLayoutFeaturesResponse(),
        handleRequest: async (path, init) => {
            if (path.split('?')[0] === '/v1/artifacts' && (init?.method ?? 'GET') === 'GET') inventories++;
            if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
            return catalog.handle(path, init);
        },
    });
    storage.setState({ isDataReady: true, artifactsLoaded: true });
    const hook = await renderHook(() => ({ rail: useSkillsLibrary(), detail: useSkillsLibrary() }));
    try {
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ rail: { status: 'ready' }, detail: { status: 'ready' } }), { timeout: 10_000 });
        expect(hook.getCurrent().rail.items).toEqual(hook.getCurrent().detail.items);
        // Each inventory opens the Account's encrypted Artifact headers; duplicate reads are material work.
        expect(inventories).toBe(1);
    } finally { await hook.unmount(); await home.dispose(); }
});

it('joins the usage row, ranks/preselects Off skills and writes one real bulk reach Action before dismissing', async () => {
    let usageUnavailable = false;
    let failRules = true;
    const catalog = createPromptLibraryCatalogBoundary({ records: [
        { key: 'skill-usage', value: { v: 1, lastUsedAt: { older: 100, recent: 123, deleted: 10 } } },
    ] });
    const home = await createPlainArtifactHomeFixture('https://skills-first-run.test', {
        serverFeatures: createRootLayoutFeaturesResponse(),
        handleRequest: async (path, init) => {
            if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
            if (path === '/v1/account/entity-rows/prompt-library/skill-rules' && init?.method === 'POST' && failRules)
                return Response.json({ status: 'conflict', revision: catalog.revision('skill-rules') });
            const response = await catalog.handle(path, init);
            if (path !== '/v1/account/entity-rows/prompt-library' || !response || !usageUnavailable) return response;
            const wire = PromptLibraryRowsListResponseV1Schema.parse(await response.json());
            if (wire.status !== 'listed') return Response.json(wire);
            return Response.json(PromptLibraryRowsListResponseV1Schema.parse({ ...wire, rows: wire.rows.map(row => row.key === 'skill-usage'
                ? { ...row, content: { t: 'plain', v: catalog.read('coding') } } : row) }));
        },
    });
    storage.getState().applyLocalSettings({ skillsFirstRunDecidedAt: null });
    for (const id of ['never', 'older', 'recent']) {
        const header = PromptBundleArtifactHeaderV1Schema.parse({ v: 1, kind: 'prompt_bundle.v2', title: id, bundleSchemaId: 'skills.skill_md_v1' });
        const body = PromptBundleBodyV1Schema.parse({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [{ path: 'SKILL.md', contentKind: 'utf8',
            contentBase64: encodeBase64(new TextEncoder().encode(`---\nname: ${id}\n---\nInstructions.`)) }] });
        expect((await home.boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id,
            header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body: JSON.stringify(body) }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER }) }))?.status).toBe(200);
    }
    // The real skills.list transport is ready before the unrelated global Artifact sync finishes.
    storage.setState({ isDataReady: true, artifactsLoaded: false });
    const hook = await renderHook(() => { const library = useSkillsLibrary(); return { library, firstRun: useSkillsFirstRun(library.items) }; });
    try {
        await vi.waitFor(() => expect(hook.getCurrent().library.status).toBe('ready'), { timeout: 10_000 });
        expect(hook.getCurrent().library.usageObservedSince).toBe(10);
        expect(hook.getCurrent().firstRun.items.map(item => item.skillId)).toEqual(['recent', 'older', 'never']);
        expect(hook.getCurrent().firstRun.selectedIds).toEqual(['recent', 'older']);
        await act(async () => hook.getCurrent().firstRun.setSelected('older', false));
        expect(hook.getCurrent().firstRun.selectedCount).toBe(1);
        const outcomes: boolean[] = [];
        await act(async () => { outcomes.push(await hook.getCurrent().firstRun.turnOn()); });
        expect(outcomes).toEqual([false]);
        expect(hook.getCurrent().firstRun.errorCode).toBe('conflict');
        expect(storage.getState().localSettings.skillsFirstRunDecidedAt).toBeNull();
        expect(hook.getCurrent().firstRun.eligible).toBe(true);
        failRules = false;
        await act(async () => { outcomes.push(...await Promise.all([hook.getCurrent().firstRun.turnOn(), hook.getCurrent().firstRun.turnOn()])); });
        expect(outcomes).toEqual([false, true, true]);
        const record = catalog.read('skill-rules');
        if (record.key !== 'skill-rules') throw new Error('Expected rules');
        expect(record.value.rules.filter(rule => rule.skillId === 'recent')).toMatchObject([{ enabled: true, target: { t: 'allMachines' } }]);
        expect(record.value.rules.filter(rule => rule.skillId === 'older' || rule.skillId === 'never')).toEqual([]);
        expect(catalog.requests.filter(request => request.key === 'skill-rules')).toHaveLength(1);
        expect(storage.getState().localSettings.skillsFirstRunDecidedAt).not.toBeNull();
        await vi.waitFor(() => expect(hook.getCurrent().firstRun.eligible).toBe(false));
        usageUnavailable = true;
        await act(async () => hook.getCurrent().library.retry());
        await vi.waitFor(() => expect(hook.getCurrent().library).toMatchObject({ status: 'ready', usageObservedSince: null }));
        expect(hook.getCurrent().library.items.every(item => item.lastUsedAt === undefined)).toBe(true);
        const ruleWrites = catalog.requests.length;
        await act(async () => hook.getCurrent().firstRun.notNow());
        expect(storage.getState().localSettings.skillsFirstRunDecidedAt).not.toBeNull();
        expect(catalog.requests).toHaveLength(ruleWrites);
    } finally { await hook.unmount(); await home.dispose(); }
});

it('surfaces a failed rules catalog without a read-refresh-cancel loop and recovers through explicit retry', async () => {
    const catalog = createPromptLibraryCatalogBoundary();
    let unavailable = true;
    let miswiredArtifacts = false;
    let catalogReads = 0;
    const home = await createPlainArtifactHomeFixture('https://skills-library-catalog.test', {
        serverFeatures: createRootLayoutFeaturesResponse(),
        handleRequest: async (path, init) => {
            // Mis-bind the genuine Home response once; the real list/Action/strict consumer must reject it.
            if (path.split('?')[0] === '/v1/artifacts' && miswiredArtifacts) return Response.json({ items: [] });
            if (path === '/v1/account/entity-rows/prompt-library') {
                catalogReads += 1;
                if (unavailable) return Response.json(PromptLibraryRowsListResponseV1Schema.parse({ status: 'invalid-stored-content' }));
            }
            if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
            const response = await catalog.handle(path, init);
            if (path === '/v1/account/entity-rows/prompt-library' && response) {
                PromptLibraryRowsListResponseV1Schema.parse(await response.clone().json());
            }
            return response;
        },
    });
    const header = PromptBundleArtifactHeaderV1Schema.parse({ v: 1, kind: 'prompt_bundle.v2', title: 'Review code', bundleSchemaId: 'skills.skill_md_v1' });
    const body = PromptBundleBodyV1Schema.parse({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [{
        path: 'SKILL.md', contentKind: 'utf8', contentBase64: encodeBase64(new TextEncoder().encode('---\nname: review-code\ndescription: Review the current diff\n---\nCheck correctness.')),
    }] });
    const seed = await home.boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: 'fixture-skill',
        header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body: JSON.stringify(body) }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    }) });
    expect(seed?.status).toBe(200);
    storage.setState({ isDataReady: true, artifactsLoaded: true });
    let hook: Awaited<ReturnType<typeof renderHook<ReturnType<typeof useSkillsLibrary>>>> | undefined;
    try {
        hook = await renderHook(useSkillsLibrary);
        await vi.waitFor(() => expect(hook!.getCurrent()).toMatchObject({ status: 'unavailable', errorCode: 'invalid-stored-content' }));
        const readsAfterFailure = catalogReads;
        await hook.rerender();
        expect(hook.getCurrent().status).toBe('unavailable');
        expect(catalogReads).toBe(readsAfterFailure);

        unavailable = false;
        await act(async () => hook!.getCurrent().retry());
        await vi.waitFor(() => expect({
            library: hook!.getCurrent(),
            rules: getPromptLibraryCatalogValue({ serverId: home.home.id, accountId: 'artifact-account' }, 'skill-rules'),
        }).toMatchObject({ library: { status: 'ready', errorCode: null }, rules: { status: 'ready' } }), { timeout: 10_000 });
        expect(hook.getCurrent().items.map(item => item.skillId)).toContain('fixture-skill');
        const lastKnown = hook.getCurrent().items;
        miswiredArtifacts = true;
        await act(async () => hook!.getCurrent().retry());
        await vi.waitFor(() => expect(hook!.getCurrent()).toMatchObject({ status: 'unavailable', stale: true }));
        expect(getPromptLibraryCatalogValue({ serverId: home.home.id, accountId: 'artifact-account' }, 'skill-rules').status).toBe('ready');
        expect(hook.getCurrent().items).toBe(lastKnown);
        miswiredArtifacts = false;
        await act(async () => hook!.getCurrent().retry());
        await vi.waitFor(() => expect(hook!.getCurrent().status).toBe('ready'));
        unavailable = true;
        await act(async () => hook!.getCurrent().retry());
        await vi.waitFor(() => expect(hook!.getCurrent()).toMatchObject({ status: 'unavailable', stale: true, errorCode: 'invalid-stored-content' }));
        expect(hook.getCurrent().items).toBe(lastKnown);
    } finally {
        await hook?.unmount();
        await home.dispose();
    }
});
