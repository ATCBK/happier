import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { SkillFoundListResultV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { SessionCapabilitySelectionAuthoringV1Schema, type SessionCapabilitySelectionV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import { MentionRefV1Schema } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { prepareWarmCacheEncryptionKey } from '../state/warmCacheEncryptionKey';

installDisconnectedServerSocketBoundary();
const transport = vi.hoisted(() => vi.fn<(input: unknown) => Promise<unknown>>());
// Native scan is an OS/network boundary. Account, Actions, catalog and selection logic remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: transport }));
const { storage } = await import('@/sync/domains/state/storage');
const { resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const { resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { useSkillsLibrary } = await import('./useSkillsLibrary');
const { useSkillComposerGroups } = await import('./useSkillComposerGroups');
const { useNewSessionCapabilities } = await import('../capabilities/session/useNewSessionCapabilities');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { loadFoundWarmCacheEntry } = await import('../state/warmCachePersistence');

afterEach(() => { standardCleanup(); resetPromptLibraryCatalogEngineForTests(); resetPromptLibraryCatalogSnapshotsForTests(); });

it('composes real library Actions, Found cache and draft selection without reads from the unopened picker', async () => {
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
    }] });
    transport.mockReset(); transport.mockResolvedValue(found);
    const scan = await createDefaultActionExecutor().execute('skills.found.list', { machineId: 'machine' },
        { serverId: scope.serverId, surface: 'ui', authority: 'present_user' });
    expect(scan).toMatchObject({ ok: true });
    expect(loadFoundWarmCacheEntry(scope.serverId, scope.accountId, 'skill', 'machine')).toMatchObject({ observedAt: 123, result: found });
    storage.setState({ isDataReady: true, artifactsLoaded: true });
    const sessionItems: readonly unknown[] = [];
    const hook = await renderHook(() => {
        const library = useSkillsLibrary();
        const [open, setOpen] = React.useState(false);
        const [targetAccount, setTargetAccount] = React.useState(scope.accountId);
        const [selection, setSelection] = React.useState<SessionCapabilitySelectionV1>({});
        const capabilities = useNewSessionCapabilities({ enabled: true, targetServerId: scope.serverId,
            machineId: 'machine', directory: '/repo', agentId: 'codex', selection, setSelection });
        const picker = useSkillComposerGroups({ open, query: '', agentId: 'codex', machineId: 'machine', sessionItems, library,
            scope: { serverId: scope.serverId, accountId: targetAccount }, capabilities });
        return { library, selection, picker, setOpen, setTargetAccount };
    });
    try {
        await vi.waitFor(() => expect(hook.getCurrent().library.status).toBe('ready'));
        const nativeReads = transport.mock.calls.length;
        expect(hook.getCurrent().picker.groups).toEqual([]);
        await act(async () => hook.getCurrent().setOpen(true));
        const rows = hook.getCurrent().picker.groups.flatMap(group => group.rows);
        expect(rows.map(row => row.name)).toEqual(['happier', 'native']);
        const libraryRow = rows.find(row => row.source === 'library')!;
        await act(async () => {
            const result = await hook.getCurrent().picker.pick(libraryRow);
            expect(result).toMatchObject({ ok: true });
            if (result.ok) MentionRefV1Schema.parse(result.mention);
        });
        expect(SessionCapabilitySelectionAuthoringV1Schema.parse(hook.getCurrent().selection).skills?.forceIncludeSkillIds).toEqual(['happier:happier']);
        const before = hook.getCurrent().selection;
        await act(async () => { expect(await hook.getCurrent().picker.pick(rows.find(row => row.source === 'found')!)).toMatchObject({ ok: true }); });
        expect(hook.getCurrent().selection).toBe(before);
        expect(transport.mock.calls.length).toBe(nativeReads);
        await act(async () => hook.getCurrent().setTargetAccount('other-account'));
        expect(hook.getCurrent().picker).toMatchObject({ groups: [], status: 'unavailable' });
        expect(await hook.getCurrent().picker.pick(libraryRow)).toEqual({ ok: false, message: 'stale_skill_pick' });
        await act(async () => hook.getCurrent().setOpen(false));
        expect(await hook.getCurrent().picker.pick(libraryRow)).toEqual({ ok: false, message: 'stale_skill_pick' });
    } finally { await hook.unmount(); }
});
