import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { SkillFoundListResultV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { SessionCapabilitySelectionAuthoringV1Schema, type SessionCapabilitySelectionV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import { prepareWarmCacheEncryptionKey } from '../state/warmCacheEncryptionKey';
import type { ActiveSuggestionsHandler } from '@/components/autocomplete/useActiveSuggestions';

installDisconnectedServerSocketBoundary();
const transport = vi.hoisted(() => vi.fn<(input: unknown) => Promise<unknown>>());
const sessionTransport = vi.hoisted(() => vi.fn<(input: unknown) => Promise<unknown>>());
// Native scan is an OS/network boundary. Account, Actions, catalog and selection logic remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: transport }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', async (importOriginal) => {
    const { installServerScopedSessionRpcModuleMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    // The generic transport returns unknown fixture bytes; the real catalog reader validates its schema.
    return installServerScopedSessionRpcModuleMock({ sessionRpcWithServerScope: (params: unknown) => sessionTransport(params) as never })(importOriginal);
});
const { storage } = await import('@/sync/domains/state/storage');
const { resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const { resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { useSkillComposerSource } = await import('./useSkillComposerSource');
const { getSuggestions, COMPOSER_SUGGESTION_KIND_DEADLINE_MS, COMPOSER_SUGGESTION_COLD_START_GRACE_MS } = await import('@/components/autocomplete/suggestions');
const { resolveComposerSuggestionKind } = await import('@/components/autocomplete/composerSuggestionKinds');
const { buildAgentInputCommandMenuItems } = await import('@/components/sessions/agentInput/commandMenu/buildAgentInputCommandMenuItems');
const { useNewSessionCapabilities } = await import('../capabilities/session/useNewSessionCapabilities');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { seedAutocompleteSessions } = await import('@/components/autocomplete/autocompleteTestFixtures');
const { SessionSkillCatalogListResponseV1Schema } = await import('@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc');
const { useActiveSuggestions } = await import('@/components/autocomplete/useActiveSuggestions');
const { useAgentInputCommandMenu } = await import('@/components/sessions/agentInput/commandMenu/useAgentInputCommandMenu');

afterEach(() => { vi.useRealTimers(); standardCleanup(); resetPromptLibraryCatalogEngineForTests(); resetPromptLibraryCatalogSnapshotsForTests(); });

it.each(['http', 'header'] as const)('opens the same mounted Session composer after a cold %s library failure', async (failure) => {
    const catalog = createPromptLibraryCatalogBoundary();
    let inventoryUnavailable = true;
    const home = await createPlainArtifactHomeFixture(`https://skill-composer-recovery-${failure}.test`, {
        serverFeatures: createRootLayoutFeaturesResponse(),
        handleRequest: async (path, init) => {
            if (inventoryUnavailable && path.split('?')[0] === '/v1/artifacts' && (init?.method ?? 'GET') === 'GET') {
                if (failure === 'http') return Response.json({ error: 'unavailable' }, { status: 503 });
                return Response.json(home.boundary.list().map(row => ({ ...row, header: 'invalid stored header' })));
            }
            return path === '/v2/account/settings/history' ? Response.json({ snapshots: [] }) : catalog.handle(path, init);
        },
    });
    storage.setState({ isDataReady: true, artifactsLoaded: false });
    seedAutocompleteSessions({ s1: { active: true, metadata: { path: '/repo' } } });
    sessionTransport.mockReset();
    sessionTransport.mockResolvedValue(SessionSkillCatalogListResponseV1Schema.parse({ skills: [] }));
    if (failure === 'header') {
        const { encodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER } = await import('@happier-dev/protocol/storage/artifactStoredContent');
        await home.boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: 'recoverable-header',
            header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: 'Recovery' }),
            body: encodePlainArtifactStoredContent({ body: 'Recovery' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER }) });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const { fetchAndApplyArtifactsList } = await import('@/sync/engine/artifacts/syncArtifacts');
        const account = await captureLazyActionAccountContext(home.home.id);
        try {
            const before = storage.getState().artifacts;
            await fetchAndApplyArtifactsList({ credentials: { token: 'token' }, encryption: null, artifactDataKeys: new Map(),
                request: account.request,
                applyArtifacts: (rows, source) => storage.getState().applyArtifacts(rows, source === 'inventory' ? before : undefined) });
            expect(storage.getState().artifactsLoaded).toBe(true);
            expect(storage.getState().artifacts['recoverable-header']?.isDecrypted).toBe(false);
        } finally { account.dispose(); }
    }
    const completed: string[][] = [];
    const hook = await renderHook(({ query }: { query: string | null }) => {
        const source = useSkillComposerSource({ serverId: home.home.id, agentId: 'codex', machineId: 'machine',
            machineName: 'MacBook Pro', owner: () => {} });
        const handler = React.useCallback<ActiveSuggestionsHandler>(async (text, signal, onUpdate) => {
            const rows = await getSuggestions('s1', text, { kinds: ['skill'], catalogs: { skills: [] }, skillSource: source, signal, onUpdate });
            if (!signal.aborted && source) completed.push(rows.map(row => row.label ?? row.text));
            return rows;
        }, [source]);
        const [suggestions, selected, moveUp, moveDown, selectionPending, , selectionForKind] = useActiveSuggestions(query, handler);
        const menu = useAgentInputCommandMenu({ suggestions, selected, selectionPending, selectionForKind, moveUp, moveDown, activeWord: query,
            activeWordRange: query ? { start: 0, end: query.length } : null, inputTextLength: query?.length ?? 0,
            handleSuggestionSelect: () => {} });
        return { source, ...menu };
    }, { initialProps: { query: null as string | null } });
    try {
        await vi.waitFor(() => expect(hook.getCurrent().source).not.toBeNull());
        await hook.rerender({ query: '$' });
        await vi.waitFor(() => expect(completed, JSON.stringify(home.requests)).toEqual([[]]), { timeout: 10_000 });
        expect(hook.getCurrent().commandMenuOpen).toBe(false);
        inventoryUnavailable = false;
        await hook.rerender({ query: null });
        await hook.rerender({ query: '$' });
        await vi.waitFor(() => expect(hook.getCurrent().commandMenuOpen, JSON.stringify(home.requests)).toBe(true), { timeout: 10_000 });
        expect(hook.getCurrent().items.map(item => [item.group, item.label])).toEqual([['Your library', 'happier']]);
        expect(completed).toEqual([[], ['happier']]);
    } finally { await hook.unmount(); await home.dispose(); }
});

it.each([
    { lateLibrary: false, abort: false },
    { lateLibrary: true, abort: false },
    { lateLibrary: true, abort: true },
])('keeps the Account library current while the Session catalog is pending (late: $lateLibrary, abort: $abort)', async ({ lateLibrary, abort }) => {
    const catalog = createPromptLibraryCatalogBoundary();
    const inventoryRequested = createDeferred<void>();
    const inventory = createDeferred<void>();
    const home = await createPlainArtifactHomeFixture(`https://skill-composer-pending-${lateLibrary}-${abort}.test`, {
        serverFeatures: createRootLayoutFeaturesResponse(),
        handleRequest: async (path, init) => {
            if (lateLibrary && path.split('?')[0] === '/v1/artifacts' && (init?.method ?? 'GET') === 'GET') {
                inventoryRequested.resolve();
                await inventory.promise;
            }
            return path === '/v2/account/settings/history' ? Response.json({ snapshots: [] }) : catalog.handle(path, init);
        },
    });
    const scope = { serverId: home.home.id, accountId: 'artifact-account' };
    // Keep this a cold read so the delayed HTTP inventory is actually consumed.
    storage.setState({ isDataReady: true, artifactsLoaded: false });
    seedAutocompleteSessions({ s1: { active: true, metadata: { path: '/repo' } } });
    const gate = createDeferred<unknown>();
    sessionTransport.mockReset(); sessionTransport.mockImplementation(() => gate.promise);
    const hook = await renderHook(() => useSkillComposerSource({ serverId: scope.serverId, agentId: 'codex',
        machineId: 'machine', machineName: 'MacBook Pro', owner: () => {} }));
    const published: string[][] = [];
    const controller = new AbortController();
    let pending: ReturnType<typeof getSuggestions> | undefined;
    try {
        await vi.waitFor(() => expect(hook.getCurrent()).not.toBeNull());
        const producer = SessionSkillCatalogListResponseV1Schema.parse({ skills: [
            { id: 'happier:happier', name: 'happier', origin: 'happier' },
            { name: 'review', origin: 'vendor', backendId: 'codex', path: '/skills/review/SKILL.md' },
        ] });
        if (lateLibrary) vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        pending = getSuggestions('s1', '$', {
            kinds: ['skill'], skillSource: hook.getCurrent(), signal: controller.signal,
            onUpdate: rows => published.push(rows.map(row => `${row.group}:${row.label}`)),
        });
        if (lateLibrary) {
            await inventoryRequested.promise;
            await vi.advanceTimersByTimeAsync(COMPOSER_SUGGESTION_KIND_DEADLINE_MS + COMPOSER_SUGGESTION_COLD_START_GRACE_MS + 1);
            if (abort) {
                controller.abort();
                expect(await pending).toEqual([]);
                inventory.resolve();
                // The shared source may finish warming, but the retired query cannot publish it.
                await hook.getCurrent()!.read();
                expect(published.some(rows => rows.includes('Your library:happier'))).toBe(false);
                return;
            }
            inventory.resolve();
        }
        // This is observable first paint, not the eventual list after the slow RPC settles.
        await vi.waitFor(() => expect(published.some(rows => rows.includes('Your library:happier'))).toBe(true));
        if (lateLibrary) {
            // The cold query settles on the first usable publication without waiting for the Machine.
            expect((await pending).map(row => `${row.group}:${row.label}`)).toEqual(['Your library:happier']);
        } else {
            gate.resolve(producer);
            const rows = await pending;
            expect(rows.map(row => `${row.group}:${row.label}`)).toEqual(['In this session:happier', 'In this session:review']);
        }
    } finally {
        inventory.resolve();
        gate.resolve(SessionSkillCatalogListResponseV1Schema.parse({ skills: [] }));
        await pending;
        await hook.unmount(); await home.dispose();
    }
});


const select = (suggestion: Parameters<NonNullable<ReturnType<typeof resolveComposerSuggestionKind>['applySelection']>>[0]['suggestion']) =>
    resolveComposerSuggestionKind('skill').applySelection!({ suggestion, inputText: '$', selection: { start: 1, end: 1 }, activeWord: { offset: 0, endOffset: 1 } });

it('applies a known library pick to its Session when the unrelated Account inventory is unavailable', async () => {
    const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
    await loadSyncSingletonForTests();
    const { SessionCurrentProjectionRecordV1Schema } = await import('@happier-dev/protocol/sessions/listing/response');
    const { createSessionOwnerMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1, projectSessionOwnerCompatibilityViewV1,
        SessionMetadataOwnerPatchV1Schema } = await import('@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1');
    const { createSessionAccessFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
    const { useSessionCapabilities } = await import('../capabilities/session/useSessionCapabilities');
    const { readSkillsLibraryItems } = await import('./useSkillsLibrary');
    const { applySuggestion } = await import('@/components/autocomplete/applySuggestion');
    const sessionId = 'c123456789012345678901234';
    const initial = createSessionOwnerMetadataV1({ metadata: { path: '/repo', host: 'MacBook', machineId: 'machine', flavor: 'codex',
        startedBy: 'daemon', runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: {} },
        agentRuntimeCapabilitiesV1: { capabilitySelection: { vendorResume: 'supported', skillsLiveReload: 'supported' } } } });
    if (!initial.ok) throw new Error('Invalid Session fixture');
    let row = SessionCurrentProjectionRecordV1Schema.parse({ id: sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }), metadataVersion: 1,
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(initial.ownerMetadata), agentState: null, agentStateVersion: 1,
        dataEncryptionKey: null, share: null, responsibleAccountId: null, responsibleAccount: null,
        effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities } });
    let inventoryUnavailable = false;
    let selectedSkillUnavailable = false;
    let skillId: string;
    const catalog = createPromptLibraryCatalogBoundary();
    const home = await createPlainArtifactHomeFixture('https://skill-composer-session.test', {
        serverFeatures: createRootLayoutFeaturesResponse(),
        handleRequest: async (path, init) => {
            if (selectedSkillUnavailable && path === `/v1/artifacts/${skillId}`)
                return Response.json({ error: 'unavailable' }, { status: 503 });
            if (path.split('?')[0] === '/v1/artifacts' && (init?.method ?? 'GET') === 'GET' && inventoryUnavailable)
                return Response.json({ error: 'unavailable' }, { status: 503 });
            if (path.startsWith(`/v2/sessions/${sessionId}`)) {
                if (init?.method === 'PATCH') {
                    const patch = SessionMetadataOwnerPatchV1Schema.parse(JSON.parse(String(init.body)));
                    expect(patch.sharedMetadata.expectedVersion).toBe(row.metadataVersion);
                    row = { ...row, ownerMetadata: patch.ownerMetadata, metadata: patch.sharedMetadata.ciphertext,
                        metadataVersion: row.metadataVersion + 1, agentState: patch.agentState.ciphertext,
                        agentStateVersion: row.agentStateVersion! + 1 };
                    return Response.json({ success: true, metadataLayoutVersion: 1, sharedMetadata: { version: row.metadataVersion },
                        agentState: { version: row.agentStateVersion } });
                }
                return Response.json({ session: row });
            }
            return path === '/v2/account/settings/history' ? Response.json({ snapshots: [] }) : catalog.handle(path, init);
        },
    });
    const scope = { serverId: home.home.id, accountId: 'artifact-account' };
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    storage.setState({ isDataReady: true, artifactsLoaded: true });
    const account = await captureLazyActionAccountContext(scope.serverId);
    try {
        const created = await account.createArtifactDocument({ header: { v: 1, kind: 'prompt_bundle.v2', title: 'Picker check', bundleSchemaId: 'skills.skill_md_v1' },
            body: JSON.stringify({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [{ path: 'SKILL.md', contentKind: 'utf8',
                contentBase64: Buffer.from('---\nname: picker-check\ndescription: Picker check\n---\nReply ready.').toString('base64') }] }) });
        skillId = created.artifactId;
    } finally { account.dispose(); }
    const metadata = projectSessionOwnerCompatibilityViewV1({ sharedMetadata: { v: 1 }, ownerMetadata: initial.ownerMetadata });
    let writeOutcome: unknown;
    const hook = await renderHook(() => {
        const capabilities = useSessionCapabilities(sessionId, metadata, { serverId: scope.serverId });
        const source = useSkillComposerSource({ serverId: scope.serverId, agentId: 'codex', machineId: 'machine',
            machineName: 'MacBook', owner: async (...args) => {
                const result = await capabilities.setItem(...args);
                writeOutcome = result;
                return result;
            } });
        return { capabilities, source };
    });
    try {
        await vi.waitFor(() => expect(hook.getCurrent().source).not.toBeNull());
        const { refreshPromptLibraryCatalog } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
        await refreshPromptLibraryCatalog(scope);
        const warmed = await createDefaultActionExecutor().execute('skills.list', {}, { ...scope, surface: 'ui', authority: 'present_user' });
        expect(warmed).toMatchObject({ ok: true });
        expect((await readSkillsLibraryItems(scope))?.some(item => item.skillId === skillId)).toBe(true);
        const rows = await getSuggestions(sessionId, '$picker-check', { kinds: ['skill'], skillSource: hook.getCurrent().source,
            catalogs: { skills: [] } });
        const picked = rows.find(item => item.structuredInput?.kind === 'skill'
            && 'id' in item.structuredInput && item.structuredInput.id === skillId);
        expect(picked).toBeDefined();
        inventoryUnavailable = true;
        let result: Awaited<ReturnType<typeof select>> | undefined;
        await act(async () => { result = await select(picked!); });
        expect(result, JSON.stringify({ writeOutcome, requests: home.requests })).toEqual({ handled: false });
        expect(applySuggestion('$', { start: 1, end: 1 }, picked!.text, ['skill']).text).toBe('$picker-check ');
        expect(hook.getCurrent().capabilities.selection.skills?.forceIncludeSkillIds).toEqual([skillId]);
        if (row.ownerMetadata?.t !== 'plain') throw new Error('Expected plain owner metadata');
        expect(projectSessionOwnerCompatibilityViewV1({ sharedMetadata: { v: 1 }, ownerMetadata: row.ownerMetadata.v }))
            .toMatchObject({ skillSelectionV1: { forceIncludeSkillIds: [skillId] } });
        expect(home.requests.filter(request => request.method === 'PATCH').map(request => request.path)).toEqual([`/v2/sessions/${sessionId}`]);
        // Addressing one id still validates its current content and custody.
        // A refusal leaves the input and the acknowledged Session selection alone.
        selectedSkillUnavailable = true;
        await act(async () => { expect(await select(picked!)).toEqual({ handled: false, preserveInput: true }); });
        expect(hook.getCurrent().capabilities.selection.skills?.forceIncludeSkillIds).toEqual([skillId]);
        expect(home.requests.filter(request => request.method === 'PATCH')).toHaveLength(1);
        // Generated callers can still use a name; exact-id precedence remains with the shared resolver.
        selectedSkillUnavailable = false;
        inventoryUnavailable = false;
        const byName = await createDefaultActionExecutor().execute('session.capabilities.set', { sessionId, kind: 'skill', id: 'picker-check', state: 'off' },
            { ...scope, surface: 'ui', authority: 'present_user' });
        expect(byName).toMatchObject({ ok: true, result: { ok: true, state: 'off' } });
        if (row.ownerMetadata?.t !== 'plain') throw new Error('Expected plain owner metadata');
        expect(projectSessionOwnerCompatibilityViewV1({ sharedMetadata: { v: 1 }, ownerMetadata: row.ownerMetadata.v }))
            .toMatchObject({ skillSelectionV1: { forceIncludeSkillIds: [], forceExcludeSkillIds: [skillId] } });
    } finally { await hook.unmount(); await home.dispose(); }
});

it('offers the library and Found groups through the real `$` kind, and a library pick turns the skill on for the draft', async () => {
    const catalog = createPromptLibraryCatalogBoundary();
    const home = await createPlainArtifactHomeFixture('https://skill-composer.test', {
        serverFeatures: createRootLayoutFeaturesResponse(),
        handleRequest: async (path, init) => path === '/v2/account/settings/history' ? Response.json({ snapshots: [] }) : catalog.handle(path, init),
    });
    await prepareWarmCacheEncryptionKey();
    const scope = { serverId: home.home.id, accountId: 'artifact-account' };
    const found = SkillFoundListResultV1Schema.parse({ scannedAt: 123, roots: [], items: [{
        name: 'native', description: null, path: '/native', digest: 'digest', agents: ['codex'], scope: 'user',
        inLibrary: null, masksLibrary: false, happierInstalled: false, pluginOwned: null,
    }, {
        name: 'hidden-native', description: null, path: '/hidden-native', digest: 'hidden-digest', agents: ['codex'], scope: 'user',
        inLibrary: null, masksLibrary: false, happierInstalled: false, pluginOwned: null, userInvocable: false,
    }] });
    transport.mockReset(); transport.mockResolvedValue(found);
    const scan = await createDefaultActionExecutor().execute('skills.found.list', { machineId: 'machine' },
        { serverId: scope.serverId, surface: 'ui', authority: 'present_user' });
    expect(scan).toMatchObject({ ok: true });
    storage.setState({ isDataReady: true, artifactsLoaded: true });
    const hook = await renderHook(() => {
        const [selection, setSelection] = React.useState<SessionCapabilitySelectionV1>({});
        const capabilities = useNewSessionCapabilities({ enabled: true, targetServerId: scope.serverId,
            machineId: 'machine', directory: '/repo', agentId: 'codex', selection, setSelection });
        const source = useSkillComposerSource({ serverId: scope.serverId, agentId: 'codex', machineId: 'machine',
            machineName: 'MacBook Pro', owner: capabilities.setItem });
        return { selection, source };
    });
    try {
        await vi.waitFor(() => expect(hook.getCurrent().source).not.toBeNull());
        const nativeReads = transport.mock.calls.length;
        const source = hook.getCurrent().source!;
        // Invocation eligibility survives Action ingress and the device-local Found cache;
        // management still has the hidden item even though `$` cannot invoke it.
        expect(source.peek().found?.result.items).toContainEqual(expect.objectContaining({ name: 'hidden-native', userInvocable: false }));
        // The Session's own catalog row leads; the library and the Machine's Found skills follow.
        const suggestions = await getSuggestions(null, '$', { kinds: ['skill'], skillSource: source,
            catalogs: { skills: [{ name: 'review', origin: 'vendor', backendId: 'codex', path: '/skills/review/SKILL.md' }] } });
        const menu = buildAgentInputCommandMenuItems(suggestions);
        expect(menu.map(item => [item.group, item.label])).toEqual([
            ['In this session', 'review'], ['Your library', 'happier'], ['Found on MacBook Pro', 'native'],
        ]);
        // The Session row keeps the payload the send path reads.
        expect(suggestions[0]!.structuredInput).toMatchObject({ kind: 'skill', name: 'review', path: '/skills/review/SKILL.md' });
        const library = suggestions.find(item => item.group === 'Your library')!;
        await act(async () => { expect(await select(library)).toEqual({ handled: false }); });
        expect(SessionCapabilitySelectionAuthoringV1Schema.parse(hook.getCurrent().selection).skills?.forceIncludeSkillIds).toEqual(['happier:happier']);
        const before = hook.getCurrent().selection;
        // A Found skill is used as it is: the token only, no selection write.
        await act(async () => { expect(await select(suggestions.find(item => item.group === 'Found on MacBook Pro')!)).toEqual({ handled: false }); });
        expect(hook.getCurrent().selection).toBe(before);
        // Mounting the source and resolving `$` never scanned the Machine again.
        expect(transport.mock.calls.length).toBe(nativeReads);
        // Search narrows every group at once.
        const narrowed = await getSuggestions(null, '$nat', { kinds: ['skill'], skillSource: source, catalogs: { skills: [] } });
        expect(narrowed.map(item => item.label)).toEqual(['native']);
    } finally { await hook.unmount(); }
});

it.each([
    { timing: { t: 'new_sessions_only' } as const, pickable: false },
    { timing: { t: 'next_turn' } as const, pickable: true },
    { timing: { t: 'applied_now' } as const, pickable: true },
])('offers library rows in a running Session as pickable only when the Agent can apply them (timing: $timing.t)', async ({ timing, pickable }) => {
    const catalog = createPromptLibraryCatalogBoundary();
    const home = await createPlainArtifactHomeFixture(`https://skill-composer-timing-${timing.t}.test`, {
        serverFeatures: createRootLayoutFeaturesResponse(),
        handleRequest: async (path, init) => path === '/v2/account/settings/history' ? Response.json({ snapshots: [] }) : catalog.handle(path, init),
    });
    await prepareWarmCacheEncryptionKey();
    const scope = { serverId: home.home.id, accountId: 'artifact-account' };
    const found = SkillFoundListResultV1Schema.parse({ scannedAt: 123, roots: [], items: [{
        name: 'native', description: null, path: '/native', digest: 'digest', agents: ['codex'], scope: 'user',
        inLibrary: null, masksLibrary: false, happierInstalled: false, pluginOwned: null,
    }] });
    transport.mockReset(); transport.mockResolvedValue(found);
    await createDefaultActionExecutor().execute('skills.found.list', { machineId: 'machine' },
        { serverId: scope.serverId, surface: 'ui', authority: 'present_user' });
    storage.setState({ isDataReady: true, artifactsLoaded: true });
    const owner = vi.fn(async () => ({ ok: true as const }));
    const handleSuggestionSelect = vi.fn();
    const hook = await renderHook(() => useSkillComposerSource({ serverId: scope.serverId, agentId: 'codex', machineId: 'machine',
        machineName: 'MacBook Pro', owner, applyTiming: timing }));
    try {
        await vi.waitFor(() => expect(hook.getCurrent()).not.toBeNull());
        const suggestions = await getSuggestions(null, '$', { kinds: ['skill'], skillSource: hook.getCurrent(),
            catalogs: { skills: [{ name: 'review', origin: 'vendor', backendId: 'codex', path: '/skills/review/SKILL.md' }] } });
        const library = suggestions.find(item => item.group === 'Your library')!;
        // The row stays visible either way, and the Session's own and Found rows are never affected.
        expect(suggestions.map(item => item.label)).toEqual(['review', 'happier', 'native']);
        expect(suggestions.filter(item => item.group !== 'Your library').some(item => item.disabled)).toBe(false);
        if (pickable) {
            expect(library.disabled).toBeUndefined();
            expect(library.selectionEffect).toBeDefined();
            await act(async () => { expect(await select(library)).toEqual({ handled: false }); });
            expect(owner).toHaveBeenCalledWith('skill', 'happier:happier', 'on', 'happier');
            return;
        }
        // The reason is the row's own subtitle, the row is announced disabled, and nothing writes the selection.
        expect(library).toMatchObject({ disabled: true, description: 'Applies to new sessions' });
        expect(library.selectionEffect).toBeUndefined();
        const menu = buildAgentInputCommandMenuItems(suggestions);
        expect(menu.find(item => item.label === 'happier')).toMatchObject({ disabled: true, description: 'Applies to new sessions' });
        // Mouse, Enter and Tab all reach the menu's one selection entry, which refuses a disabled row.
        const picker = await renderHook(() => useAgentInputCommandMenu({ suggestions, selected: suggestions.indexOf(library),
            selectionForKind: () => ({ selected: suggestions.indexOf(library), selectionPending: false }),
            activeWord: '$', activeWordRange: { start: 0, end: 1 }, inputTextLength: 1, moveUp: () => {}, moveDown: () => {}, handleSuggestionSelect }));
        try {
            await act(async () => { picker.getCurrent().onSelectFromMenu(); picker.getCurrent().onSelectIndexFromMenu(suggestions.indexOf(library)); });
            expect(handleSuggestionSelect).not.toHaveBeenCalled();
            await act(async () => { picker.getCurrent().onSelectIndexFromMenu(suggestions.indexOf(suggestions.find(item => item.group === 'Found on MacBook Pro')!)); });
            expect(handleSuggestionSelect).toHaveBeenCalledTimes(1);
        } finally { await picker.unmount(); }
        expect(owner).not.toHaveBeenCalled();
    } finally { await hook.unmount(); await home.dispose(); }
});
