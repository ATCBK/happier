import { afterEach, expect, it, vi } from 'vitest';
import { act, createDeferred, createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { createSeededSkillsHome } from '@/dev/testkit/harness/skillsSurfaceHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { PromptBundleArtifactHeaderV1Schema, PromptBundleBodyV1Schema } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';

installDisconnectedServerSocketBoundary();
// A native inventory scan is the Machine transport boundary, never a library prerequisite.
const nativeScan = vi.hoisted(() => vi.fn<(input: unknown) => Promise<unknown>>());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: nativeScan }));
const { storage } = await import('@/sync/domains/state/storage');
const { observePromptLibraryCatalog, resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const { getPromptLibraryCatalogValue, resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { useSkillsLibrary, readSkillsLibraryItems } = await import('./useSkillsLibrary');
const { useSkillsFirstRun } = await import('@/components/settings/skills/firstRun/useSkillsFirstRun');
const { useReachProjection } = await import('@/sync/domains/capabilities/reach/useReachProjection');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { adoptHomeProfile } = await import('@/sync/domains/server/serverProfiles');
const { SkillFoundListResultV1Schema, SKILL_MACHINE_ACTION_OUTPUT_SCHEMAS_V1 } = await import('@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1');

afterEach(() => {
    standardCleanup();
    resetPromptLibraryCatalogEngineForTests();
    resetPromptLibraryCatalogSnapshotsForTests();
});

it.each(['local', 'remote'] as const)('updates a mounted library after a %s reach mutation without reload', async origin => {
    const home = await createSeededSkillsHome(`https://skills-reach-${origin}.test`, {
        skills: [{ id: 'reach-skill' }, { id: 'unchanged-skill' }],
        records: [{ key: 'skill-rules', value: { v: 1, rules: [{ id: 'reach-on', skillId: 'reach-skill',
            target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 }] } }],
    });
    const hook = await renderHook(() => useSkillsLibrary());
    const contentReads = () => home.requests.filter(request => request.path === '/v1/artifacts/read'
        || request.method === 'GET' && ['/v1/artifacts/reach-skill', '/v1/artifacts/unchanged-skill'].includes(request.path)).length;
    try {
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
        expect(hook.getCurrent().items.find(item => item.skillId === 'reach-skill')?.rules[0]?.enabled).toBe(true);
        const opened = contentReads();
        const unchanged = hook.getCurrent().items.find(item => item.skillId === 'unchanged-skill');
        const codecs = await import('@happier-dev/protocol/prompts/library/promptLibraryRowsV1');
        const decrypts = vi.spyOn(codecs, 'openPromptLibraryContentV1');
        for (const enabled of [false, true]) {
            const requestStart = home.requests.length;
            decrypts.mockClear();
            await act(async () => {
                if (origin === 'local') {
                    const result = await createDefaultActionExecutor().execute('skills.rules.set', {
                        items: [{ skillId: 'reach-skill' }],
                        change: { kind: 'write', write: { place: { t: 'allMachines' }, state: enabled ? 'on' : 'off' } },
                    }, { serverId: home.home.id, surface: 'ui', authority: 'present_user' });
                    expect(result).toMatchObject({ ok: true, result: { ok: true } });
                } else {
                    const record = home.catalog.read('skill-rules');
                    if (record.key !== 'skill-rules') throw new Error('Expected skill rules');
                    const response = await home.catalog.handle('/v1/account/entity-rows/prompt-library/skill-rules', {
                        method: 'POST', body: JSON.stringify({ expectedRevision: home.catalog.revision('skill-rules'),
                            content: { t: 'plain', v: { ...record, value: { ...record.value,
                                rules: record.value.rules.map(rule => ({ ...rule, enabled, updatedAt: rule.updatedAt + 1 })) } } } }),
                    });
                    expect(await response?.json()).toMatchObject({ status: 'updated' });
                    const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
                    publishHomeAccountChange(home.home.id, undefined, { source: 'catch-up-pending' });
                }
            });
            await vi.waitFor(() => expect(hook.getCurrent().items.find(item => item.skillId === 'reach-skill')?.rules[0]?.enabled).toBe(enabled));
            expect(hook.getCurrent().items.filter(item => item.rules.some(rule => rule.enabled)).length).toBe(enabled ? 1 : 0);
            expect(hook.getCurrent().items.find(item => item.skillId === 'unchanged-skill')).toBe(unchanged);
            // The local writer validates its addressed skill; a rules-only remote
            // publication does not reopen content through either transport.
            if (origin === 'remote') {
                const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
                const { buildPromptLibraryPhysicalKeyV1 } = await import('@happier-dev/protocol/prompts/library/promptLibraryRowsV1');
                const entityId = buildPromptLibraryPhysicalKeyV1('skill-rules');
                await act(async () => publishHomeAccountChange(home.home.id, [entityId], {
                    entityRevisions: { [entityId]: home.catalog.revision('skill-rules') }, changeKinds: ['account'],
                }));
                await new Promise<void>(resolve => setImmediate(resolve));
                expect(contentReads()).toBe(opened);
                expect(home.requests.slice(requestStart).filter(r => r.path.includes('prompt-library') || r.path.includes('/artifacts')
                    || r.path.includes('/account/settings')).map(r => `${r.method} ${r.path}`))
                    .toEqual(['GET /v1/account/entity-rows/prompt-library/skill-rules']);
            }
            const requests = home.requests.slice(requestStart).map(({ method, path }) => ({ method, path }));
            console.info(JSON.stringify({ phase: origin, enabled, requests, rowDecrypts: decrypts.mock.calls.length,
                bodyReads: requests.filter(r => r.path.includes('/artifacts/') && r.method !== 'POST').length }));
        }
        decrypts.mockRestore();
    } finally { await hook.unmount(); await home.dispose(); }
});

it('projects personal folder moves and clears without reopening content or replacing unrelated rows', async () => {
    const home = await createSeededSkillsHome('https://skills-personal-folders.test', {
        skills: [{ id: 'moving', header: { folderId: 'old' } }, { id: 'unchanged' }],
        records: [{ key: 'folders', value: { v: 1, folders: [
            { id: 'old', name: 'Old' }, { id: 'work', name: 'Work' },
        ] } }],
    });
    const hook = await renderHook(() => useSkillsLibrary());
    try {
        await vi.waitFor(() => expect(hook.getCurrent().items.find(item => item.skillId === 'moving')?.folderId).toBe('old'));
        const unchanged = hook.getCurrent().items.find(item => item.skillId === 'unchanged');
        expect(unchanged).toBeDefined();
        const contentReads = () => home.requests.filter(request => request.path === '/v1/artifacts/read'
            || request.method === 'GET' && ['/v1/artifacts/moving', '/v1/artifacts/unchanged'].includes(request.path)).length;
        const opened = contentReads();
        expect(opened).toBeGreaterThan(0);
        for (const folderId of ['work', null]) {
            await act(async () => {
                const result = await createDefaultActionExecutor().execute('artifact.folder.set', {
                    artifactId: 'moving', folderId, expectedRevision: home.catalog.revision('folders'),
                }, { serverId: home.home.id, surface: 'ui', authority: 'present_user' });
                expect(result).toMatchObject({ ok: true, result: { status: 'updated' } });
            });
            await vi.waitFor(() => expect(hook.getCurrent().items.find(item => item.skillId === 'moving')?.folderId).toBe(folderId));
            expect(hook.getCurrent().items.find(item => item.skillId === 'unchanged')).toBe(unchanged);
            expect(contentReads()).toBe(opened);
        }
    } finally { await hook.unmount(); await home.dispose(); }
});

it('keeps a complete cold library current through unchanged partial header publication and still reads edits and removals', async () => {
    const home = await createSeededSkillsHome('https://skills-partial-publication.test', {
        skills: [{ id: 'published' }, { id: 'other' }],
    });
    const hook = await renderHook(() => useSkillsLibrary());
    const readsOf = (id: string) => home.requests.filter(request => request.path === '/v1/artifacts/read'
        || request.method === 'GET' && request.path === `/v1/artifacts/${id}`).length;
    try {
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', stale: false }), { timeout: 10_000 });
        expect(storage.getState().artifactsLoaded).toBe(false);
        expect(readsOf('other')).toBe(1);
        const rows = hook.getCurrent().items;
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(home.home.id);
        try {
            // An addressed sync publication is not a new version of content the list already opened.
            await act(async () => { await account.fetchArtifact('published'); });
        } finally { account.dispose(); }
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', stale: false }));
        expect(hook.getCurrent().items).toBe(rows);
        expect(readsOf('other')).toBe(1);

        const row = home.boundary.read('published')!;
        home.boundary.replaceStoredRow({ ...row, bodyVersion: 2 });
        const published = storage.getState().artifacts.published!;
        await act(async () => storage.getState().updateArtifact({ ...published, bodyVersion: 2 }));
        await vi.waitFor(() => expect(hook.getCurrent().items.find(item => item.skillId === 'published')?.revision).toBe('1:2'));
        expect(readsOf('other')).toBe(2);

        expect((await home.boundary.handle('/v1/artifacts/published', { method: 'DELETE' }))?.status).toBe(200);
        await act(async () => storage.getState().deleteArtifact('published'));
        await vi.waitFor(() => expect(hook.getCurrent().items.some(item => item.skillId === 'published')).toBe(false));
        expect(readsOf('other')).toBe(3);
    } finally { await hook.unmount(); await home.dispose(); }
});

it('reissues a picker read after the first open fails without substituting an empty success', async () => {
    let unavailable = true;
    let reads = 0;
    const catalog = createPromptLibraryCatalogBoundary();
    const home = await createPlainArtifactHomeFixture('https://skills-picker-recovery.test', {
        serverFeatures: createRootLayoutFeaturesResponse(),
        handleRequest: async (path, init) => {
            if (path.split('?')[0] === '/v1/artifacts' && (init?.method ?? 'GET') === 'GET') {
                reads++;
                if (unavailable) return Response.json({ error: 'unavailable' }, { status: 503 });
            }
            return path === '/v2/account/settings/history' ? Response.json({ snapshots: [] }) : catalog.handle(path, init);
        },
    });
    const scope = { serverId: home.home.id, accountId: 'artifact-account' };
    storage.setState({ isDataReady: true, artifactsLoaded: false });
    try {
        expect(await readSkillsLibraryItems(scope)).toBeNull();
        const failedReads = reads;
        expect(failedReads).toBeGreaterThan(0);
        unavailable = false;
        const recovered = await readSkillsLibraryItems(scope);
        expect(recovered?.some(item => item.provenance.kind === 'first_party')).toBe(true);
        expect(reads).toBeGreaterThan(failedReads);
    } finally { await home.dispose(); }
});

it('publishes the rail library and rules while native inventory is pending, then fills Machine facts without rereading the library', async () => {
    const catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'skill-rules', value: { v: 1, rules: [
        { id: 'rail-on', skillId: 'rail-skill', target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 },
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
    const header = PromptBundleArtifactHeaderV1Schema.parse({ v: 1, kind: 'prompt_bundle.v2', title: 'rail-skill', bundleSchemaId: 'skills.skill_md_v1' });
    const body = PromptBundleBodyV1Schema.parse({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [{ path: 'SKILL.md', contentKind: 'utf8',
        contentBase64: encodeBase64(new TextEncoder().encode('---\nname: rail-skill\n---\nReview the current diff.')) }] });
    expect((await home.boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: 'rail-skill',
        header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body: JSON.stringify(body) }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER }) }))?.status).toBe(200);
    const deferred = createDeferred<unknown>();
    nativeScan.mockReset(); nativeScan.mockReturnValue(deferred.promise);
    let scanSettled = false;
    const scan = createDefaultActionExecutor().execute('skills.found.list', { machineId: 'native-machine' }, {
        serverId: scope.serverId, surface: 'ui', authority: 'present_user',
    }).finally(() => { scanSettled = true; });
    storage.setState({ settingsScope: scope, profileScope: scope, isDataReady: true, artifactsLoaded: false, machines: {},
        machineListByServerId: { [scope.serverId]: [] }, machineListStatusByServerId: { [scope.serverId]: 'loading' } });
    const hook = await renderHook(() => ({ library: useSkillsLibrary(), reach: useReachProjection('skill', 'rail-skill') }));
    try {
        await vi.waitFor(() => expect(nativeScan).toHaveBeenCalled());
        await vi.waitFor(() => expect(hook.getCurrent().library.status).toBe('ready'), { timeout: 10_000 });
        expect(scanSettled).toBe(false);
        expect(hook.getCurrent().library.items.find(item => item.skillId === 'rail-skill')).toMatchObject({ rules: [{ enabled: true }] });
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
        const receipt = await scan;
        expect(receipt).toMatchObject({ ok: true });
        if (receipt.ok) SKILL_MACHINE_ACTION_OUTPUT_SCHEMAS_V1['skills.found.list'].parse(receipt.result);
    } finally {
        deferred.resolve(SkillFoundListResultV1Schema.parse({ scannedAt: 123, roots: [], items: [] }));
        await scan;
        await hook.unmount(); await home.dispose();
    }
});

it('shares ready catalog authority and the real library read across simultaneous rail and detail observers', async () => {
    let inventories = 0;
    let holdCatalogReads = false;
    const catalogRead = createDeferred<void>();
    const catalog = createPromptLibraryCatalogBoundary();
    const home = await createPlainArtifactHomeFixture('https://skills-observers.test', {
        serverFeatures: createRootLayoutFeaturesResponse(),
        handleRequest: async (path, init) => {
            if (path === '/v1/account/entity-rows/prompt-library' && holdCatalogReads) await catalogRead.promise;
            if (path.split('?')[0] === '/v1/artifacts' && (init?.method ?? 'GET') === 'GET') inventories++;
            if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
            return catalog.handle(path, init);
        },
    });
    // No inventory has been published: exercise the real cold Account read.
    storage.setState({ isDataReady: true, artifactsLoaded: false });
    const scope = storage.getState().settingsScope;
    if (!scope) throw new Error('Expected Account scope');
    const stopCatalogObservation = observePromptLibraryCatalog(scope);
    await vi.waitFor(() => expect(getPromptLibraryCatalogValue(scope, 'skill-rules').status).toBe('ready'));
    // A list borrows the current publication. A fresh mutation-base read may
    // wait on Home, but it must not hold this already-admitted library hostage.
    holdCatalogReads = true;
    const hook = await renderHook(() => ({ rail: useSkillsLibrary(), detail: useSkillsLibrary() }));
    try {
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ rail: { status: 'ready' }, detail: { status: 'ready' } }), { timeout: 10_000 });
        expect(hook.getCurrent().rail.items).toEqual(hook.getCurrent().detail.items);
        // Each inventory opens the Account's encrypted Artifact headers; duplicate reads are material work.
        expect(inventories).toBe(1);
    } finally {
        catalogRead.resolve();
        await hook.unmount(); stopCatalogObservation(); await home.dispose();
    }
});

it.each([false, true])('starts cold content before rules and preserves revision freshness (edit during read: %s)', async editDuringRead => {
    const catalogReady = createDeferred<void>();
    const bodyReady = createDeferred<void>();
    let inventories = 0;
    let bodyReads = 0;
    const catalog = createPromptLibraryCatalogBoundary();
    const home = await createPlainArtifactHomeFixture(`https://skills-cold-critical-path-${editDuringRead}.test`, {
        serverFeatures: createRootLayoutFeaturesResponse(),
        handleRequest: async (path, init) => {
            if (path === '/v1/account/entity-rows/prompt-library') await catalogReady.promise;
            if (path.split('?')[0] === '/v1/artifacts' && (init?.method ?? 'GET') === 'GET') inventories++;
            if (path === '/v1/artifacts/read' || path === '/v1/artifacts/cold-skill' && (init?.method ?? 'GET') === 'GET') {
                bodyReads++;
                const response = await home.boundary.handle(path, init);
                await bodyReady.promise;
                return response;
            }
            return path === '/v2/account/settings/history' ? Response.json({ snapshots: [] }) : catalog.handle(path, init);
        },
    });
    const header = PromptBundleArtifactHeaderV1Schema.parse({ v: 1, kind: 'prompt_bundle.v2', title: 'cold-skill', bundleSchemaId: 'skills.skill_md_v1' });
    const body = PromptBundleBodyV1Schema.parse({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [{ path: 'SKILL.md', contentKind: 'utf8',
        contentBase64: encodeBase64(new TextEncoder().encode('---\nname: cold-skill\ndescription: Original\n---\nInstructions.')) }] });
    await home.boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: 'cold-skill',
        header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body: JSON.stringify(body) }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER }) });
    storage.setState({ isDataReady: true, artifactsLoaded: false, artifacts: {} });
    const hook = await renderHook(() => useSkillsLibrary());
    try {
        // The real Action must reach the content transport while the rules census is held.
        await vi.waitFor(() => expect(bodyReads).toBe(1));
        expect(hook.getCurrent().status).toBe('loading');
        catalogReady.resolve();
        const replaceBody = (description: string, bodyVersion: number) => {
            const row = home.boundary.read('cold-skill')!;
            const updatedBody = { ...body, entries: [{ ...body.entries[0]!,
                contentBase64: encodeBase64(new TextEncoder().encode(`---\nname: cold-skill\ndescription: ${description}\n---\nInstructions.`)) }] };
            home.boundary.replaceStoredRow({ ...row, bodyVersion, updatedAt: row.updatedAt + 1,
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(updatedBody) }) });
        };
        if (editDuringRead) replaceBody('Concurrent', 2);
        const { fetchAndApplyArtifactsList } = await import('@/sync/engine/artifacts/syncArtifacts');
        const { withUiPromptLibraryArtifactStore } = await import('@/sync/ops/promptLibrary/promptLibraryArtifactStore');
        await act(async () => withUiPromptLibraryArtifactStore(async (_store, account) => {
            const basis = storage.getState().artifacts;
            await fetchAndApplyArtifactsList({ credentials: account.credentials, request: account.request,
                encryption: null, artifactDataKeys: new Map(),
                applyArtifacts: (rows, source) => storage.getState().applyArtifacts(rows, source === 'inventory' ? basis : undefined) });
        }, { serverId: home.home.id }));
        bodyReady.resolve();
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', stale: false }), { timeout: 10_000 });
        expect(hook.getCurrent().items.find(item => item.skillId === 'cold-skill')).toMatchObject(editDuringRead
            ? { revision: '1:2', description: 'Concurrent' } : { revision: '1:1', description: 'Original' });
        expect(bodyReads).toBe(editDuringRead ? 2 : 1);
        expect(inventories).toBe(2); // One cold Action scan plus the shared inventory publication.
        const nextVersion = editDuringRead ? 3 : 2;
        replaceBody('Changed', nextVersion);
        const projected = storage.getState().artifacts['cold-skill']!;
        await act(async () => storage.getState().updateArtifact({ ...projected, bodyVersion: nextVersion }));
        await vi.waitFor(() => expect(hook.getCurrent().items.find(item => item.skillId === 'cold-skill'))
            .toMatchObject({ revision: `1:${nextVersion}`, description: 'Changed' }), { timeout: 10_000 });
        expect(bodyReads).toBe(editDuringRead ? 3 : 2);
    } finally {
        catalogReady.resolve(); bodyReady.resolve();
        await hook.unmount(); await home.dispose();
    }
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
    // This case exercises bulk rule CAS; approval continuations have dedicated real-wiring coverage.
    const previousActionSettings = storage.getState().settings.actionsSettingsV1;
    storage.getState().applySettingsLocal({ actionsSettingsV1: setActionApprovalOverride({
        settings: previousActionSettings, actionId: 'skills.rules.set',
        surface: 'ui', approvalRequired: false,
    }) });
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
    } finally {
        await hook.unmount();
        storage.getState().applySettingsLocal({ actionsSettingsV1: previousActionSettings });
        await home.dispose();
    }
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
    expect((await home.boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: 'unreadable-skill',
        header: encodePlainArtifactStoredContent({ ...header, title: 'Retained unreadable skill' }),
        body: encodePlainArtifactStoredContent({ body: '{malformed' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    }) }))?.status).toBe(200);
    // The fixtures exist at Home, before the focused inventory has hydrated.
    storage.setState({ isDataReady: true, artifactsLoaded: false });
    let hook: Awaited<ReturnType<typeof renderHook<ReturnType<typeof useSkillsLibrary>>>> | undefined;
    try {
        hook = await renderHook(() => useSkillsLibrary());
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
        const failures = [{ skillId: 'unreadable-skill', title: 'Retained unreadable skill', reason: 'skill_content_unavailable' }];
        expect(hook.getCurrent().unavailableItems).toEqual(failures);
        const lastKnown = hook.getCurrent().items;
        miswiredArtifacts = true;
        await act(async () => hook!.getCurrent().retry());
        await vi.waitFor(() => expect(hook!.getCurrent()).toMatchObject({ status: 'unavailable', stale: true }));
        expect(getPromptLibraryCatalogValue({ serverId: home.home.id, accountId: 'artifact-account' }, 'skill-rules').status).toBe('ready');
        expect(hook.getCurrent().items).toBe(lastKnown);
        expect(hook.getCurrent().unavailableItems).toEqual(failures);
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
