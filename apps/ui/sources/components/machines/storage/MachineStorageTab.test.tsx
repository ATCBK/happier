import * as React from 'react';
import { Platform } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiskScanStateV1, HappierStorageSummaryV1, MachineStorageCategoryListResultV1, StorageItemV1 } from '@happier-dev/protocol/storage/storageV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DiskScanStateV1Schema, HappierStorageSummaryV1Schema, MachineStorageScanStartInputV1Schema } from '@happier-dev/protocol/storage/storageV1';
import { MachineResourcesPolicyV1Schema } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';
import type { WorkflowDefinitionDraftSeed } from '@/sync/domains/workflows/workflowDefinitionDraftSeed';
import { peekTempData } from '@/utils/sessions/tempDataStore';

import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createSessionFixture, renderScreen } from '@/dev/testkit';
import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionActionFixture } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';

installDisconnectedServerSocketBoundary();
const routerPush = vi.hoisted(() => vi.fn());
vi.mock('expo-router', () => ({ useRouter: () => ({ push: routerPush }) }));
const transport = vi.hoisted(() => ({ rpc: vi.fn() }));
// The platform clipboard boundary; Copy path's own owner runs above it.
const clipboard = vi.hoisted(() => ({ setStringAsync: vi.fn(async (_text: string) => true) }));
vi.mock('expo-clipboard', () => clipboard);
// The modal presentation boundary: the review sheet's own component is rendered by the test from what the tab hands it.
const modal = vi.hoisted(() => ({ current: null as null | Awaited<ReturnType<typeof import('@/dev/testkit/mocks/modal')['createModalModuleMock']>> }));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    modal.current = createModalModuleMock();
    return modal.current.module;
});
vi.mock('@/components/ui/popover', async (importOriginal) => {
    const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
    return createInlinePopoverModuleMock(importOriginal);
});
// Only the Machine network is replaced; credential binding, Actions, the storage and policy stores and the tab run for real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: transport.rpc }));
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { resolveServerCredentialAccountScope } = await import('@/sync/domains/scope/serverCredentialAccountScope');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { preloadTranslationsForSettings, setPreferredLanguageFromSettings, t } = await import('@/text');
const { machineStorageStore } = await import('@/sync/domains/machines/storage/machineStorageStore');
const { storage } = await import('@/sync/domains/state/storageStore');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { MachineStorageTab } = await import('./MachineStorageTab');

const GB = 1_000_000_000;
const size = (bytes: number) => ({ allocatedBytes: bytes, freesBytes: bytes, sharedBytes: 0, sharedExtentsUnmeasured: false, atLeast: false });

const SUMMARY: HappierStorageSummaryV1 = {
    revision: 1, sizedAt: Date.UTC(2026, 9, 10, 10, 41),
    volumes: [
        { volume: { volumeId: 'mac', mountPath: '/', label: 'Macintosh HD' }, totalBytes: 994 * GB, freeBytes: 412 * GB, happierBytes: 96 * GB, pileBytes: 0, trashBytes: 0 },
        { volume: { volumeId: 'work', mountPath: '/Volumes/Work', label: 'Work' }, totalBytes: 2_000 * GB, freeBytes: 1_200 * GB, happierBytes: 0, pileBytes: 0, trashBytes: 0 },
    ],
    categories: [
        { categoryId: 'caches', size: size(17.6 * GB), canGoBytes: 17 * GB, count: 3, detailFacts: { canGoCount: 3, keepCount: 0, factsReported: true } },
        { categoryId: 'worktrees', size: size(58.4 * GB), canGoBytes: 23.8 * GB, count: 192, detailFacts: { canGoCount: 61, keepCount: 131, factsReported: true } },
        { categoryId: 'agentHomes', size: size(1.9 * GB), canGoBytes: 0, count: 2, detailFacts: { canGoCount: 0, keepCount: 2, factsReported: true } },
    ],
    suggestionsTop: [], pile: { count: 0, freesBytes: 0, droppedSinceLastView: [] }, trash: { count: 0, allocatedBytes: 0 },
    wholeDisk: { enabled: false, scans: [] },
};

function item(itemId: string, title: string, bytes: number, verdict: StorageItemV1['verdict'], code: StorageItemV1['reason']['code']): StorageItemV1 {
    return { itemId, kind: 'category-item', categoryId: 'caches', title, evidence: [], path: `/Users/leeroy/Library/Caches/${itemId}`,
        size: size(bytes), verdict, reason: { code }, collectable: verdict !== 'forbidden' };
}

const CACHES: MachineStorageCategoryListResultV1 = {
    revision: 1, sizedAt: SUMMARY.sizedAt, categoryId: 'caches',
    items: [
        item('pw', 'Playwright 1.56', 0.6 * GB, 'keep', 'in_use'),
        item('pnpm', 'pnpm store', 9.8 * GB, 'safe', 'downloads_again'),
        item('sys', 'System caches', 2 * GB, 'forbidden', 'system'),
    ],
};

function machine(overrides: Partial<Machine> = {}): Machine {
    return createMachineFixture({ id: 'machine', activeAt: Date.now(), storageMode: 'plain', isShared: false,
        metadata: { host: 'leeroy-mbp', platform: 'darwin', happyCliVersion: '0.3.0', happyHomeDir: '/Users/leeroy/.happier', homeDir: '/Users/leeroy' },
        access: { role: 'manage', custodian: { accountId: 'owner', displayName: 'Owner' }, resourceMode: 'plain', accessState: 'ready' },
        daemonState: { resources: { v: 1, vitals: { state: 'reporting' },
            host: { logicalCores: 4, memoryTotalBytes: 100, bootedAt: 1 }, attention: { level: 'calm', reasons: [] } } },
        ...overrides });
}

type Rpc = Readonly<{ method: string; payload?: Record<string, unknown> }>;
/** What the machine answers for a served reference: its own identity and who collected it. */
const resolved = (ref: Record<string, unknown>) => ({ itemId: ref.itemId, path: ref.path, identity: { dev: '1', ino: String(ref.itemId), kind: 'directory' },
    collectedAt: 1, collectedBy: { accountId: 'owner', kind: 'person' } });
/** The machine page owns the tab's params; a controlled host lets a test follow them as the page would. */
let setControlledParams: ((next: React.ComponentProps<typeof MachineStorageTab>['params']) => void) | null = null;
function ControlledStorageTab(props: Readonly<{ serverId: string; initial: React.ComponentProps<typeof MachineStorageTab>['params'] }>) {
    const [params, setParams] = React.useState(props.initial);
    setControlledParams = setParams;
    return <MachineStorageTab serverId={props.serverId} machineId="machine" machineName="leeroy-mbp" online params={params}
        setParams={(next) => setParams(next as typeof params)} />;
}
async function mount(params: React.ComponentProps<typeof MachineStorageTab>['params'], overrides: Partial<Machine> = {},
    answer?: (rpc: Rpc) => unknown, controlled = false) {
    const serverId = await home.addHome({ name: 'Storage Home', serverUrl: `https://storage-tab-${Math.random().toString(36).slice(2)}.test`,
        serverIdentityId: 'srv_storage_tab', accountId: 'owner' });
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse() } });
    // Chart tests exercise admitted view changes; approval policy stays real and this person permits Settings writes.
    const settings = settingsParse({
        actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
    });
    home.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
    // Mounted settings and known Project rows consume the applied Home/Account lifetime.
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const resolution = await resolveServerCredentialAccountScope(serverId);
    if (resolution.kind !== 'bound') throw new Error('Storage Home must be bound');
    storage.getState().activateProfileScope(resolution.scope);
    await storage.getState().activateSettingsScope(resolution.scope);
    storage.getState().applySettings(settings, 1);
    storage.setState({ machines: {}, machineListByServerId: { [serverId]: [machine(overrides)] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    transport.rpc.mockImplementation(async (rpc: Rpc) => {
        const { method } = rpc;
        const answered = answer?.(rpc);
        if (answered !== undefined) return answered;
        if (method === RPC_METHODS.DAEMON_STORAGE_WATCH) return new Promise(() => {});
        if (method === RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST) return CACHES;
        return SUMMARY;
    });
    const setParams = vi.fn();
    // The machine page is a page-presentation list; the tab renders inside it.
    const screen = await renderScreen(<ListPresentationProvider value="page">{controlled
        ? <ControlledStorageTab serverId={serverId} initial={params} />
        : <MachineStorageTab serverId={serverId} machineId="machine" machineName="leeroy-mbp" online params={params} setParams={setParams} />}</ListPresentationProvider>);
    return { screen, setParams, serverId };
}
/** A running session on this machine whose worktree is in use (the real session stop Action reaches it by the Machine network). */
async function holdingSession(serverId: string) {
    await loadSyncSingletonForTests();
    const metadata = createSessionFixture().metadata;
    if (!metadata) throw new Error('The canonical Session fixture must have readable metadata');
    const session = installSessionActionFixture({ homes: home, storage, serverId, session: { id: 'sess-1',
        metadata: { ...metadata, path: '/Users/leeroy/dev/happier/.dev/worktree/live', host: 'leeroy-mbp', homeDir: '/Users/leeroy', machineId: 'machine', flavor: 'codex' } } });
    const http = createSessionMetadataHttpBoundary(() => ({ [session.id]: session }));
    // Person Stop persists its hold through Sync before asking the daemon to stop.
    // Serve that real writer at the existing Home HTTP boundary.
    const answer = { select: async (_input: unknown, request: Readonly<{ url: string; init: RequestInit | undefined }>) => {
        const response = http.handle(request.url, request.init);
        if (!response) throw new Error('Holding Session metadata route was not handled');
        return { status: response.status, body: await response.json() };
    } };
    home.answer(serverId, `/v2/sessions/${session.id}`, answer);
    home.answer(serverId, `/v2/sessions/${session.id}?accessProjectionVersion=1`, answer);
    return http;
}

const before = storage.getState();
beforeEach(async () => { await home.reset(); machineStorageStore.reset(); transport.rpc.mockReset(); routerPush.mockReset(); });
afterEach(async () => { standardCleanup(); setPreferredLanguageFromSettings('en'); machineStorageStore.reset(); storage.setState(before); await home.reset(); });

describe('MachineStorageTab', () => {
    it('refreshes mounted worktree evidence search when the language changes', async () => {
        await preloadTranslationsForSettings('fr');
        setPreferredLanguageFromSettings('fr');
        const frenchEvidence = t('machineStorage.evidence.scm_registered_worktree');
        setPreferredLanguageFromSettings('en');
        const worktree: StorageItemV1 = { ...item('locale', 'Feature branch', GB, 'safe', 'merged_clean'),
            kind: 'worktree', categoryId: 'worktrees', evidence: ['scm_registered_worktree'],
            path: '/Users/leeroy/dev/project/.dev/worktree/locale' };
        const { screen } = await mount({ id: 'storage', page: 'worktrees' }, {}, ({ method }) => {
            if (method === RPC_METHODS.DAEMON_STORAGE_WORKTREES_LIST) return { revision: 1, items: [worktree] };
            return undefined;
        });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-storage-worktree-locale')).not.toBeNull()); });
        await act(async () => { screen.changeTextByTestId('machine-storage-worktrees-find', frenchEvidence); });
        expect(screen.findByTestId('machine-storage-worktree-locale')).toBeNull();
        await act(async () => { setPreferredLanguageFromSettings('fr'); });
        expect(screen.findByTestId('machine-storage-worktree-locale')).not.toBeNull();
        expect(screen.getTextContent()).toContain(frenchEvidence);
        await act(async () => { setPreferredLanguageFromSettings('en'); });
        expect(screen.findByTestId('machine-storage-worktree-locale')).toBeNull();
    });

    it.each([
        { id: 'storage' },
        { id: 'storage', page: 'category', categoryId: 'caches' },
        { id: 'storage', page: 'suggestions' },
        { id: 'storage', page: 'worktrees' },
        { id: 'storage', prepare: 'lowDisk', volumeId: 'mac' },
    ] satisfies Array<React.ComponentProps<typeof MachineStorageTab>['params']>)('presents evidence without exposing machine codes on %j', async (params) => {
        // A Machine transport response may contain a future evidence code or native recognizer identifiers.
        const evidence = ['managed_cache_root', 'recognizer:private-cache-detector', 'manifest:private-project.json', 'future_private_evidence'];
        const suggestion = { ...item('evidence', 'Tool cache', GB, 'safe', 'downloads_again'), evidence };
        const { screen } = await mount(params, {}, ({ method }) => {
            if (method === RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET) return { ...SUMMARY, suggestionsTop: [suggestion] };
            if (method === RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST) return { ...CACHES, items: [suggestion] };
            if (method === RPC_METHODS.DAEMON_STORAGE_SUGGESTIONS_LIST || method === RPC_METHODS.DAEMON_STORAGE_WORKTREES_LIST) {
                return { revision: 1, items: [suggestion] };
            }
            return undefined;
        });
        const rowId = 'prepare' in params ? 'machine-storage-lowdisk-evidence'
            : params.page === 'category' ? 'machine-storage-item-evidence'
            : params.page === 'suggestions' ? 'machine-storage-suggestion-evidence'
            : params.page === 'worktrees' ? 'machine-storage-worktree-evidence'
            : 'machine-storage-top-suggestion-evidence';
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId(rowId)).not.toBeNull()); });
        const text = screen.getTextContent();
        for (const raw of evidence) expect(text).not.toContain(raw);
        expect(text).not.toContain('private-cache-detector');
        expect(text).not.toContain('private-project.json');
        for (const key of ['managed_cache_root', 'recognizer', 'manifest', 'unknown'] as const) {
            expect(text).toContain(t(`machineStorage.evidence.${key}`));
        }
    });

    it('honors Allowed Empty directly from Trash and keeps the exact displayed selection', async () => {
        const calls: Rpc[] = [];
        const { screen, serverId } = await mount({ id: 'storage', page: 'category', categoryId: 'trash' }, {}, rpc => {
            calls.push(rpc);
            if (rpc.method === RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST) return { revision: 1, sizedAt: SUMMARY.sizedAt, categoryId: 'trash', items: [],
                trashEntries: [{ entryId: 'entry-a', batchId: 'batch-a', volumeId: 'mac', originalPath: '/logs/old', title: 'Old log',
                    size: size(64), movedAt: 1, movedBy: { accountId: 'owner', kind: 'person' }, emptiesAt: null, restorable: true }] };
            if (rpc.method === RPC_METHODS.DAEMON_STORAGE_TRASH_EMPTY) return { outcomes: [{ entryId: 'entry-a', status: 'deleted' }], freedBytes: 64 };
            return undefined;
        });
        const settings = settingsParse({ actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'machines.storage.trash.empty': ['ui'] } } });
        home.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 2 } });
        storage.getState().applySettings(settings, 2);
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-storage-trash-empty-all')).not.toBeNull()); });
        modal.current!.spies.confirm.mockClear().mockResolvedValue(false);
        await act(async () => { screen.pressByTestId('machine-storage-trash-empty-all'); });
        await act(async () => { await vi.waitFor(() => expect(calls.filter(call => call.method === RPC_METHODS.DAEMON_STORAGE_TRASH_EMPTY)).toHaveLength(1)); });
        expect(calls.find(call => call.method === RPC_METHODS.DAEMON_STORAGE_TRASH_EMPTY)?.payload).toEqual({ serverId: 'srv_storage_tab', machineId: 'machine', entryIds: ['entry-a'] });
        expect(modal.current!.spies.confirm).not.toHaveBeenCalled();
    });

    it('asks nothing more once the person has reviewed a permanent delete in the sheet', async () => {
        const ref = resolved({ itemId: 'old-log', path: '/logs/old' });
        const calls: Rpc[] = [];
        const { screen } = await mount({ id: 'storage' }, {}, rpc => {
            calls.push(rpc);
            if (rpc.method === RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET) return { ...SUMMARY, pile: { count: 1, freesBytes: 64, droppedSinceLastView: [] } };
            if (rpc.method === RPC_METHODS.DAEMON_STORAGE_PILE_GET) return { revision: 1, items: [ref], summary: { count: 1, freesBytes: 64, droppedSinceLastView: [] } };
            if (rpc.method === RPC_METHODS.DAEMON_STORAGE_DELETE_NOW) return { batchId: 'delete-a', mode: 'delete', inTrashBytes: 0, freedBytes: 64, outcomes: [{ itemId: 'old-log', status: 'deleted' }] };
            if (rpc.method === RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK) return { items: [{ ref, expect: 'checked-log', verdict: 'safe', reason: { code: 'rebuilds' }, size: size(64), absorbs: [] }],
                staying: [], countedOnceBytes: 0, totalFreesBytes: 64, trashVolumes: [{ volumeId: 'mac', trashAvailable: true }] };
            return undefined;
        });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-storage-pile-review')).not.toBeNull()); });
        await act(async () => { screen.pressByTestId('machine-storage-pile-review'); });
        const shown = modal.current!.spies.show.mock.calls.at(-1)?.[0] as { component: React.ComponentType<Record<string, unknown>>; props: Record<string, unknown> };
        const close = vi.fn();
        const Sheet = shown.component;
        const sheet = await renderScreen(<Sheet {...shown.props} onClose={close} />);
        await act(async () => { await vi.waitFor(() => expect(sheet.findByTestId('machine-storage-review-row-old-log')).not.toBeNull()); });
        await act(async () => { sheet.pressByTestId('machine-storage-review-mode:delete'); });
        modal.current!.spies.confirm.mockClear();
        await act(async () => { sheet.pressByTestId('machine-storage-review-confirm'); });
        await act(async () => { await vi.waitFor(() => expect(calls.filter(call => call.method === RPC_METHODS.DAEMON_STORAGE_DELETE_NOW)).toHaveLength(1)); });
        // The sheet's own button is the one confirmation of an irreversible delete: no second dialog follows it.
        expect(modal.current!.spies.confirm).not.toHaveBeenCalled();
        expect(sheet.getTextContent()).not.toContain(t('machineStorage.review.applyFailed'));
    });

    it.each(['web', 'ios', 'android'] as const)('announces a worktree group as none, mixed, all, then none on %s', async platform => {
        // Only the platform SDK fact changes; the group, pile controller and shared Pressable stay real.
        const originalPlatform = Object.getOwnPropertyDescriptor(Platform, 'OS')!;
        Object.defineProperty(Platform, 'OS', { ...originalPlatform, value: platform });
        try {
            const items: StorageItemV1[] = ['a', 'b'].map(id => ({
                itemId: `wt-${id}`, kind: 'worktree', categoryId: 'worktrees', title: id, evidence: [],
                path: `/Users/leeroy/dev/happier/.dev/worktree/${id}`, size: size(GB),
                verdict: 'safe', reason: { code: 'merged_clean' }, collectable: true,
            }));
            let pile: Array<Record<string, unknown>> = [];
            const pileResult = () => ({ revision: 2, items: pile, summary: { count: pile.length, freesBytes: pile.length * GB, droppedSinceLastView: [] } });
            const { screen } = await mount({ id: 'storage', page: 'worktrees' }, {}, ({ method, payload }) => {
                if (method === RPC_METHODS.DAEMON_STORAGE_WORKTREES_LIST) return { revision: 1, items };
                if (method === RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET) return { ...SUMMARY, pile: pileResult().summary };
                if (method === RPC_METHODS.DAEMON_STORAGE_PILE_GET) return pileResult();
                if (method === RPC_METHODS.DAEMON_STORAGE_PILE_SET) {
                    const remove = (payload?.remove as string[] | undefined) ?? [];
                    pile = [...pile.filter(entry => !remove.includes(String(entry.itemId))),
                        ...((payload?.add as Array<Record<string, unknown>> | undefined) ?? []).map(resolved)];
                    return pileResult();
                }
                return undefined;
            });
            const groupId = 'machine-storage-worktrees-group-happier-collect';
            const expectChecked = async (checked: boolean | 'mixed') => {
                await act(async () => { await vi.waitFor(() => {
                    const control = screen.findHostByTestId(groupId);
                    expect(control?.props.accessibilityState?.checked).toBe(checked);
                    expect(control?.props['aria-checked']).toBe(checked);
                }); });
            };
            await expectChecked(false);
            await act(async () => { screen.pressByTestId('machine-storage-worktree-wt-a-collect'); });
            await expectChecked('mixed');
            await act(async () => { screen.pressByTestId(groupId); });
            await expectChecked(true);
            await act(async () => { screen.pressByTestId(groupId); });
            await expectChecked(false);
            expect(pile).toEqual([]);
        } finally { Object.defineProperty(Platform, 'OS', originalPlatform); }
    });

    it('shows the daemon’s concrete main-checkout lifecycle limitation in Staying, with apply unavailable', async () => {
        const ref = { itemId: '/Users/leeroy/projects', path: '/Users/leeroy/projects' };
        const pile = { count: 1, freesBytes: GB, droppedSinceLastView: [] };
        const { screen } = await mount({ id: 'storage' }, {}, ({ method }) => {
            if (method === RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET) return { ...SUMMARY, pile };
            if (method === RPC_METHODS.DAEMON_STORAGE_PILE_GET) return { revision: 1, items: [resolved(ref)], summary: pile };
            if (method === RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK) return { items: [], staying: [{ item: { ...ref, title: 'Projects' },
                reason: { code: 'unsupported', detail: { cause: 'main_checkout_lifecycle_unsupported', owner: 'scm', path: '/Users/leeroy/projects/happier' } } }],
                countedOnceBytes: 0, totalFreesBytes: 0, trashVolumes: [] };
            return undefined;
        });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-storage-pile-review')).not.toBeNull()); });
        await act(async () => { screen.pressByTestId('machine-storage-pile-review'); });
        const shown = modal.current!.spies.show.mock.calls.at(-1)![0] as { component: React.ComponentType<Record<string, unknown>>; props: Record<string, unknown> };
        const Sheet = shown.component;
        const sheet = await renderScreen(<Sheet {...shown.props} onClose={() => {}} />);
        await act(async () => { await vi.waitFor(() => expect(sheet.findByTestId(`machine-storage-review-staying-${ref.itemId}`)).not.toBeNull()); });
        expect(sheet.getTextContent()).toContain(t('machineStorage.ownerLimitations.mainCheckout'));
        expect(sheet.findByTestId('machine-storage-review-confirm')?.props.disabled).toBe(true);
    });
    it.each([
        { threshold: { freeFraction: 0.05 }, free: 80 * GB, total: 1_000 * GB, full: false, volumeId: 'mac' },
        { threshold: { freeFraction: 0.2 }, free: 150 * GB, total: 1_000 * GB, full: true, volumeId: 'mac' },
        { threshold: { freeBytes: 100 * GB }, free: 80 * GB, total: 500 * GB, full: true, volumeId: 'work' },
        { threshold: { freeBytes: 100 * GB }, free: 150 * GB, total: 2_000 * GB, full: false, volumeId: 'mac' },
        { threshold: { freeFraction: 0.1 }, free: 80 * GB, total: 1_000 * GB, full: true, volumeId: 'mac' },
    ])('reviews the selected disk using its configured threshold $threshold and always preselects Trash', async ({ threshold, free, total, full, volumeId }) => {
        const ref = { itemId: 'cache', path: volumeId === 'work' ? '/Volumes/Work/cache' : '/Users/leeroy/cache' };
        const pile = { count: 1, freesBytes: GB, droppedSinceLastView: [] };
        const summary = { ...SUMMARY, pile, volumes: SUMMARY.volumes.map(volume => volume.volume.volumeId === volumeId
            ? { ...volume, totalBytes: total, freeBytes: free } : volume) };
        const own = machine();
        const { screen } = await mount({ id: 'storage' }, { metadata: { ...own.metadata!, resourcesPolicyV1:
            MachineResourcesPolicyV1Schema.parse({ v: 1, alerts: { disk: { enabled: false, threshold } } }) } }, ({ method }) => {
            if (method === RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET) return summary;
            if (method === RPC_METHODS.DAEMON_STORAGE_PILE_GET) return { revision: 1, items: [resolved(ref)], summary: pile };
            if (method === RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK) return { items: [{ ref: resolved(ref), expect: 'checked', verdict: 'safe',
                reason: { code: 'rebuilds' }, size: size(GB), absorbs: [] }], staying: [], countedOnceBytes: 0, totalFreesBytes: GB,
                trashVolumes: [{ volumeId, trashAvailable: true }] };
            return undefined;
        });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-storage-pile-review')).not.toBeNull()); });
        await act(async () => { screen.pressByTestId('machine-storage-pile-review'); });
        const shown = modal.current!.spies.show.mock.calls.at(-1)![0] as { component: React.ComponentType<Record<string, unknown>>; props: Record<string, unknown> };
        const Sheet = shown.component;
        const sheet = await renderScreen(<Sheet {...shown.props} onClose={() => {}} />);
        await act(async () => { await vi.waitFor(() => expect(sheet.findByTestId('machine-storage-review-where')).not.toBeNull()); });
        const where = sheet.root.find(node => typeof node.type !== 'string' && node.props.testID === 'machine-storage-review-where');
        const label = summary.volumes.find(volume => volume.volume.volumeId === volumeId)!.volume.label;
        expect(where.props.title).toBe(full ? t('machineStorage.review.whereTrashOn', { volume: label }) : t('machineStorage.review.whereTrash'));
        expect(sheet.getTextContent()).toContain(t('machineStorage.review.moveToTrash', { count: 1 }));
    });

    it('queries unfiltered Large files, optional sizes and Old whole-day ages through the real scan Action, retaining values on invalid or canceled input', async () => {
        const scan: DiskScanStateV1 = { scanId: 'custom-scan', target: { volumeId: 'mac' }, status: 'complete', startedAt: 1, finishedAt: 2,
            progress: { sizedBytes: GB, usedBytes: GB, items: 1 }, unreadable: { counts: { permission: 0, os_private: 0, timeout: 0, io: 0 }, examples: [] },
            fullDiskAccess: { state: 'not_applicable', binary: { name: 'happier-support', path: '/x' } } };
        const { screen } = await mount({ id: 'storage', view: 'disk', files: 'large' }, {}, ({ method, payload }) => {
            if (method === RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET) return { ...SUMMARY, wholeDisk: { enabled: true, scans: [scan] } };
            if (method === RPC_METHODS.DAEMON_STORAGE_SCAN_GET) return { state: scan, nodes: (payload?.view as { olderThanDays?: number } | undefined)?.olderThanDays === 45 ? [{
                nodeId: '/Users/leeroy/notes', parentId: '/Users/leeroy', name: 'notes', kind: 'file', size: size(20), logicalBytes: 20, items: 1,
                changedAt: Date.now() - 60 * 86_400_000, childCount: 0, flags: { happier: false, protection: 'none', atLeast: false, inUse: false },
            }] : [], coverage: [] };
            if (method === RPC_METHODS.DAEMON_STORAGE_PILE_GET) return { revision: 1, items: [], summary: SUMMARY.pile };
            return undefined;
        }, true);
        const lastView = () => (transport.rpc.mock.calls.map(call => call[0] as Rpc).filter(call => call.method === RPC_METHODS.DAEMON_STORAGE_SCAN_GET).at(-1)?.payload?.view);
        async function expectView(view: Record<string, unknown>) {
            await vi.waitFor(async () => { await act(async () => {}); expect(lastView()).toEqual(view); });
        }
        async function custom(testId: string, raw: string | null) {
            const prompts = modal.current!.spies.prompt.mock.calls.length;
            modal.current!.spies.prompt.mockResolvedValueOnce(raw);
            await act(async () => { screen.pressByTestId(`${testId}.trigger`); });
            await vi.waitFor(async () => {
                await act(async () => {});
                expect(screen.findByTestId(`${testId}:${testId.endsWith('large-min') ? '100000000' : '3'}`), JSON.stringify({ open: screen.findByTestId(testId)?.props.open, text: screen.getTextContent() })).not.toBeNull();
            });
            await act(async () => { screen.pressByTestId(`${testId}:custom`); });
            // Menu actions wait for presentation teardown before opening the OS prompt.
            await vi.waitFor(async () => { await act(async () => {}); expect(modal.current!.spies.prompt).toHaveBeenCalledTimes(prompts + 1); });
        }
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(lastView(), JSON.stringify({ methods: transport.rpc.mock.calls.map(call => (call[0] as Rpc).method), text: screen.getTextContent() }))
                .toEqual({ tab: 'large', depth: 1 });
        });
        async function chooseSize(id: string) {
            await act(async () => { screen.pressByTestId('machine-storage-disk-large-min.trigger'); });
            await vi.waitFor(async () => { await act(async () => {}); expect(screen.findByTestId(`machine-storage-disk-large-min:${id}`)).not.toBeNull(); });
            await act(async () => { screen.pressByTestId(`machine-storage-disk-large-min:${id}`); });
        }
        await chooseSize('10000000');
        await expectView({ tab: 'large', depth: 1, minBytes: 10_000_000 });
        await custom('machine-storage-disk-large-min', '2.5 MB');
        await expectView({ tab: 'large', depth: 1, minBytes: 2_500_000 });
        await custom('machine-storage-disk-large-min', '1 B');
        await expectView({ tab: 'large', depth: 1, minBytes: 1 });
        await custom('machine-storage-disk-large-min', '0');
        expect(lastView()).toMatchObject({ minBytes: 1 });
        await custom('machine-storage-disk-large-min', null);
        expect(lastView()).toMatchObject({ minBytes: 1 });
        await chooseSize('all');
        await expectView({ tab: 'large', depth: 1 });
        await act(async () => { screen.pressByTestId('machine-storage-disk-files:old'); });
        await act(async () => { await vi.waitFor(() => expect(lastView()).toMatchObject({ tab: 'old', olderThanMonths: 3 })); });
        await custom('machine-storage-disk-old-months', '45 days');
        await expectView({ tab: 'old', depth: 1, olderThanDays: 45 });
        await act(async () => { await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('machineStorage.disk.ageGroups.recent'))); });
        await custom('machine-storage-disk-old-months', '1');
        await expectView({ tab: 'old', depth: 1, olderThanDays: 1 });
        await custom('machine-storage-disk-old-months', '2.5');
        await custom('machine-storage-disk-old-months', null);
        expect(lastView()).toMatchObject({ olderThanDays: 1 });
    });
    it('renders scan progress and completion while revision watches advance during a pending scan read', async () => {
        const folder = '/home/happier/dz3-leeroy/qa8-owned-fixtures';
        const running: DiskScanStateV1 = { scanId: 'folder-scan', target: { folderPath: folder }, status: 'running', startedAt: 3,
            progress: { sizedBytes: 0, usedBytes: 0, items: 0 },
            unreadable: { counts: { permission: 0, os_private: 0, timeout: 0, io: 0 }, examples: [] },
            fullDiskAccess: { state: 'not_applicable', binary: { name: 'happier-support', path: '/x' } } };
        let summary = { ...SUMMARY, wholeDisk: { enabled: true, scans: [] as DiskScanStateV1[] } };
        const watches: ReturnType<typeof createDeferred<unknown>>[] = [];
        const pages: ReturnType<typeof createDeferred<unknown>>[] = [];
        const node = { nodeId: `${folder}/file`, parentId: folder, name: 'file', kind: 'file', size: size(131072), logicalBytes: 131072,
            items: 1, changedAt: 1, flags: { happier: false, protection: 'none', atLeast: false, inUse: false }, childCount: 0 };
        const scanMachine = machine();
        const { screen, serverId } = await mount({ id: 'storage', view: 'disk' }, { metadata: { ...scanMachine.metadata!,
            resourcesPolicyV1: MachineResourcesPolicyV1Schema.parse({ v: 1, storage: { wholeDiskEnabled: true } }) } }, ({ method }) => {
            if (method === RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET) return summary;
            if (method === RPC_METHODS.DAEMON_STORAGE_SCAN_START) return running;
            if (method === RPC_METHODS.DAEMON_STORAGE_WATCH || method === RPC_METHODS.DAEMON_STORAGE_SCAN_GET) {
                const pending = createDeferred<unknown>();
                (method === RPC_METHODS.DAEMON_STORAGE_WATCH ? watches : pages).push(pending);
                return pending.promise;
            }
            if (method === RPC_METHODS.DAEMON_STORAGE_PILE_GET) return { revision: 1, items: [], summary: SUMMARY.pile };
            return undefined;
        });
        await act(async () => { await vi.waitFor(() => expect(watches.length).toBeGreaterThan(0)); });
        const resolution = await resolveServerCredentialAccountScope(serverId);
        expect(resolution.kind).toBe('bound');
        if (resolution.kind !== 'bound') throw new Error('Storage Home must be bound');
        await act(async () => { expect(await machineStorageStore.startScan({ serverId: resolution.scope.serverId, expectedAccountId: resolution.scope.accountId, machineId: 'machine', target: running.target })).toMatchObject({ ok: true }); });
        expect(screen.findByTestId('machine-storage-disk')).not.toBeNull();
        summary = { ...summary, revision: 2, wholeDisk: { enabled: true, scans: [running] } };
        await act(async () => { watches.at(-1)!.resolve({ changed: true, summary }); await vi.waitFor(() => expect(pages).toHaveLength(1)); });
        const progress = { ...running, progress: { ...running.progress, sizedBytes: 131072, items: 1 } };
        summary = { ...summary, revision: 3, wholeDisk: { enabled: true, scans: [progress] } };
        await act(async () => { watches.at(-1)!.resolve({ changed: true, summary }); });
        await act(async () => { pages[0]!.resolve({ state: progress, nodes: [node], coverage: [], indexedAt: 4 }); await vi.waitFor(() => expect(pages).toHaveLength(2)); });
        expect(screen.findByTestId(`machine-storage-disk-row-${folder}/file`)).not.toBeNull();
        // A folder scan has no total to divide by: it stays indeterminate and never shows a made-up share.
        expect(screen.findByTestId('machine-storage-disk-progress')?.props.accessibilityValue).toBeUndefined();
        expect(screen.getTextContent()).toContain(t('machineStorage.disk.progressMetaOpen', { sized: formatMachineBytes(131072, 'storage'), items: '1' }));
        expect(screen.getTextContent()).not.toMatch(/\d+\s?%/);
        const complete: DiskScanStateV1 = { ...running, status: 'complete', finishedAt: 5, progress: { sizedBytes: 266240, usedBytes: 266240, items: 3 } };
        summary = { ...summary, revision: 4, wholeDisk: { enabled: true, scans: [complete] } };
        await act(async () => { watches.at(-1)!.resolve({ changed: true, summary }); });
        await act(async () => { pages[1]!.resolve({ state: complete, nodes: [node], coverage: [], indexedAt: 5 }); await vi.waitFor(() => expect(pages).toHaveLength(3)); });
        await act(async () => { pages[2]!.resolve({ state: complete, nodes: [node], coverage: [], indexedAt: 5 }); });
        expect(screen.findByTestId(`machine-storage-disk-row-${folder}/file`)).not.toBeNull();
        expect(screen.getTextContent()).toContain('qa8-owned-fixtures holds');
    });
    it('opens weekly storage review as an ordinary scheduled Automation draft from Storage settings', async () => {
        const { screen } = await mount({ id: 'storage' });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-storage-tidy-weekly-review')).not.toBeNull()); });
        await act(async () => { screen.pressByTestId('machine-storage-tidy-weekly-review'); });
        const route = routerPush.mock.calls.at(-1)?.[0] as { pathname: string; params: { definitionDraftSeedId: string } };
        expect(route.pathname).toBe('/workflows/new');
        const seed = peekTempData<{ seed: WorkflowDefinitionDraftSeed }>(route.params.definitionDraftSeedId)?.seed;
        expect(seed?.trigger?.kind).toBe('schedule');
        expect(seed?.definition.blocks[0]).toMatchObject({ document: { text: expect.stringContaining('Move items to Trash') } });
    });
    it('says what Happier holds, draws each disk with its share and lists kinds biggest first with what can go', async () => {
        const { screen, setParams } = await mount({ id: 'storage' });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-storage-sentence')).not.toBeNull()); });
        const sentence = screen.getTextContent();
        expect(sentence).toContain('412 GB free. Happier uses 96 GB of Macintosh HD. About 40.8 GB of that can go.');
        expect(sentence).toContain('Nothing of Happier’s is on this disk');
        expect(sentence).toContain('Happier uses 96 GB');
        const order = ['worktrees', 'caches', 'agentHomes'].map(id => sentence.indexOf(id === 'worktrees' ? 'Worktrees' : id === 'caches' ? 'Plugin and tool caches' : 'Agent homes'));
        expect(order).toEqual([...order].sort((a, b) => a - b));
        expect(sentence).toContain('192 worktrees · 61 can be deleted');
        expect(sentence).toContain('23.8 GB can go');
        expect(sentence).toContain('Always kept');
        // Keeping it tidy reads the machine's one policy: defaults until someone changes them.
        expect(sentence).toContain('Keeping it tidy');
        expect(sentence).toContain('30 days');
        expect(sentence).toContain('After 7 days');
        await act(async () => { screen.pressByTestId('machine-storage-category-caches'); });
        expect(setParams).toHaveBeenCalledWith({ id: 'storage', page: 'category', categoryId: 'caches' });
    });

    it('opens a kind’s page in one row anatomy, biggest first, each saying why it stays or can go (R42)', async () => {
        const { screen, setParams } = await mount({ id: 'storage', page: 'category', categoryId: 'caches' });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-storage-item-pnpm')).not.toBeNull()); });
        const text = screen.getTextContent();
        expect(text).toContain('17.6 GB of caches. Tools download or rebuild all of it when they need it. 17 GB can go.');
        expect(text.indexOf('pnpm store')).toBeLessThan(text.indexOf('System caches'));
        expect(text.indexOf('System caches')).toBeLessThan(text.indexOf('Playwright 1.56'));
        expect(text).toContain('Safe · downloads again');
        expect(text).toContain('Keep · in use');
        expect(text).toContain('Forbidden · system location');
        expect(text).toContain('~/Library/Caches/pnpm');
        expect(text).not.toMatch(/Protected/u);
        await act(async () => { screen.pressByTestId('machine-storage-page-back'); });
        expect(setParams).toHaveBeenCalledWith({ id: 'storage' });
    });

    it('says a pushed page’s machine is offline once it goes away after a failed read, without a Retry that cannot send', async () => {
        const { screen, serverId } = await mount({ id: 'storage', page: 'category', categoryId: 'caches' }, {}, (rpc) =>
            rpc.method === RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST ? Promise.reject(new Error('no answer')) : undefined);
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-storage-page-error')).not.toBeNull()); });
        await act(async () => {
            storage.setState({ machineListByServerId: { [serverId]: [machine({ active: false, activeAt: Date.now() - 60 * 60_000 })] } });
        });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-storage-page-offline')).not.toBeNull()); });
        expect(screen.findByTestId('machine-storage-page-error')).toBeNull();
        expect(screen.getTextContent()).not.toContain('Try again');
    });

    it('groups a kind’s page the way the machine groups it: stopped long ago first, then recent or running', async () => {
        const folder = (itemId: string, title: string, bytes: number, verdict: StorageItemV1['verdict'], code: StorageItemV1['reason']['code']): StorageItemV1 => ({
            itemId, kind: 'category-item', categoryId: 'sessionFolders', title, evidence: [], path: `/Users/leeroy/.happier/sessions/${itemId}`,
            size: size(bytes), verdict, reason: { code }, collectable: true });
        const { screen } = await mount({ id: 'storage', page: 'category', categoryId: 'sessionFolders' }, {}, (rpc) => rpc.method === RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST ? {
            revision: 1, sizedAt: SUMMARY.sizedAt, categoryId: 'sessionFolders',
            items: [folder('live', 'Live session', 3 * GB, 'keep', 'in_use'), folder('old-a', 'Old session A', 1 * GB, 'safe', 'stopped'),
                folder('old-b', 'Old session B', 2 * GB, 'safe', 'stopped'), folder('new', 'New session', 5 * GB, 'keep', 'recent')],
            groups: [{ id: 'stopped', olderThanDays: 30, itemIds: ['old-a', 'old-b'] }, { id: 'recent', itemIds: ['live', 'new'] }],
        } : undefined);
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-storage-item-old-a')).not.toBeNull()); });
        const text = screen.getTextContent();
        const at = (value: string) => text.indexOf(value);
        expect(at('Stopped over 30 days ago')).toBeGreaterThanOrEqual(0);
        // Each group biggest first, the stopped group above the recent one.
        expect(at('Stopped over 30 days ago')).toBeLessThan(at('Old session B'));
        expect(at('Old session B')).toBeLessThan(at('Old session A'));
        expect(at('Old session A')).toBeLessThan(at('Recent or running'));
        expect(at('Recent or running')).toBeLessThan(at('New session'));
        expect(at('New session')).toBeLessThan(at('Live session'));
    });

    it('shows a person who only uses the machine its totals, never what is inside or its settings', async () => {
        const { screen } = await mount({ id: 'storage' }, { isShared: true });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-storage-recipient')).not.toBeNull()); });
        const text = screen.getTextContent();
        expect(text).toContain('412 GB free. Happier uses 96 GB of Macintosh HD.');
        expect(text).not.toContain('can go');
        expect(screen.findByTestId('machine-storage-breakdown')).toBeNull();
        expect(text).not.toContain('Keeping it tidy');
    });

    it('gives a person who only uses the machine their own Session folders and Trash, and their own pile on those pages', async () => {
        const { screen, setParams } = await mount({ id: 'storage' }, { isShared: true });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-storage-category-sessionFolders')).not.toBeNull()); });
        expect(screen.findByTestId('machine-storage-category-trash')).not.toBeNull();
        // Everything else stays with the people who manage the machine.
        expect(screen.findByTestId('machine-storage-category-worktrees')).toBeNull();
        await act(async () => { screen.pressByTestId('machine-storage-category-trash'); });
        expect(setParams).toHaveBeenCalledWith({ id: 'storage', page: 'category', categoryId: 'trash' });

        const page = await mount({ id: 'storage', page: 'category', categoryId: 'trash' }, { isShared: true }, (rpc) => {
            if (rpc.method === RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET) return { ...SUMMARY, categories: [], pile: { count: 1, freesBytes: 64, droppedSinceLastView: [] } };
            return undefined;
        });
        await act(async () => { await vi.waitFor(() => expect(page.screen.findByTestId('machine-storage-pile-review')).not.toBeNull()); });
    });

    it('collects worktrees into the pile, asks before a Keep one, reviews, narrows, and moves exactly what stays ticked to Trash', async () => {
        const worktree = (itemId: string, title: string, verdict: StorageItemV1['verdict'], code: StorageItemV1['reason']['code'], extra: Partial<StorageItemV1> = {}): StorageItemV1 => ({
            itemId, kind: 'worktree', categoryId: 'worktrees', title, evidence: ['scm_registered_worktree'], path: `/Users/leeroy/dev/happier/.dev/worktree/${title}`,
            size: size(2 * GB), verdict, reason: { code }, collectable: verdict !== 'check', ...extra });
        const ITEMS = [
            worktree('wt-a', 'issues-282', 'safe', 'merged_clean'),
            worktree('wt-b', 'dev-post-snapshot', 'safe', 'merged_clean'),
            worktree('wt-keep', 'materialized', 'keep', 'changed_files', { loses: [{ code: 'changed_files', detail: { count: 3 } }] }),
            worktree('wt-check', 'terminal-fonts', 'check', 'facts_unavailable'),
        ];
        let pile: Array<Record<string, unknown>> = [];
        const pileResult = () => ({ revision: 2, items: pile, summary: { count: pile.length, freesBytes: pile.length * 2 * GB, droppedSinceLastView: [] } });
        const calls: Rpc[] = [];
        const { screen } = await mount({ id: 'storage', page: 'worktrees' }, {}, (rpc) => {
            calls.push(rpc);
            const input = rpc.payload ?? {};
            switch (rpc.method) {
                case RPC_METHODS.DAEMON_STORAGE_WORKTREES_LIST: return { revision: 1, items: ITEMS };
                case RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST: return { revision: 1, sizedAt: SUMMARY.sizedAt, categoryId: 'trash', items: [],
                    trashEntries: [{ entryId: 'e-a', batchId: 'batch-1', volumeId: 'mac', originalPath: ITEMS[0]!.path, title: 'issues-282', categoryId: 'worktrees',
                        size: size(2 * GB), movedAt: 1, movedBy: { accountId: 'owner', kind: 'person' }, emptiesAt: Date.UTC(2026, 9, 18), restorable: true }] };
                // The machine's summary carries its pile, as the daemon's does.
                case RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET: return { ...SUMMARY, pile: pileResult().summary };
                case RPC_METHODS.DAEMON_STORAGE_PILE_GET: return pileResult();
                case RPC_METHODS.DAEMON_STORAGE_PILE_SET: {
                    const remove = (input.remove as string[] | undefined) ?? [];
                    // The machine resolves identity and records who collected each served reference.
                    pile = [...pile.filter(entry => !remove.includes(entry.itemId as string)), ...((input.add as Array<Record<string, unknown>> | undefined) ?? []).map(resolved)];
                    return pileResult();
                }
                case RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK: return {
                    items: (input.refs as Array<Record<string, unknown>>).map(ref => ({ ref: resolved(ref), expect: `expect-${String(ref.itemId)}`, verdict: 'safe',
                        reason: { code: 'merged_clean' }, size: size(2 * GB), absorbs: [] })),
                    staying: [], countedOnceBytes: 0, totalFreesBytes: 4 * GB, trashVolumes: [{ volumeId: 'mac', trashAvailable: true }] };
                case RPC_METHODS.DAEMON_STORAGE_TRASH_MOVE: return { batchId: 'batch-1', mode: 'trash', inTrashBytes: 2 * GB, freedBytes: 0,
                    outcomes: (input.items as Array<{ ref: { itemId: string } }>).map(entry => ({ itemId: entry.ref.itemId, status: 'moved' })) };
                default: return undefined;
            }
        }, true);
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-storage-worktree-wt-a')).not.toBeNull()); });
        const text = screen.getTextContent();
        expect(text).toContain('Can delete · merged, clean');
        expect(text).toContain('Keep · changed files');
        expect(text).toContain('Check now');
        expect(text).toContain('happier');
        const pileSets = () => calls.filter(call => call.method === RPC_METHODS.DAEMON_STORAGE_PILE_SET);

        await act(async () => { screen.pressByTestId('machine-storage-worktree-wt-a-collect'); });
        await act(async () => { await vi.waitFor(() => expect(pileSets()).toHaveLength(1)); });
        expect(pileSets()[0]!.payload!.add).toEqual([{ itemId: 'wt-a', path: ITEMS[0]!.path }]);

        // A Keep worktree asks first, naming what is lost; declining sends nothing.
        await act(async () => { screen.pressByTestId('machine-storage-worktree-wt-keep-collect'); });
        await act(async () => { await vi.waitFor(() => expect(modal.current!.spies.confirm).toHaveBeenCalled()); });
        expect(modal.current!.spies.confirm.mock.calls.at(-1)?.[1]).toContain('3 files with changes are lost.');
        expect(pileSets()).toHaveLength(1);

        // The Project header collects all that can go: only wt-b remains, never the Keep or unchecked one.
        await act(async () => { screen.pressByTestId('machine-storage-worktrees-group-happier-collect'); });
        await act(async () => { await vi.waitFor(() => expect(pileSets()).toHaveLength(2)); });
        expect((pileSets()[1]!.payload!.add as Array<{ itemId: string }>).map(entry => entry.itemId)).toEqual(['wt-b']);

        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-storage-pile-review')).not.toBeNull()); });
        expect(screen.getTextContent()).toContain('2 items');
        await act(async () => { screen.pressByTestId('machine-storage-pile-review'); });
        const shown = modal.current!.spies.show.mock.calls.at(-1)?.[0] as { component: React.ComponentType<Record<string, unknown>>; props: Record<string, unknown> };
        expect(shown.component).toBeTypeOf('function');
        const close = vi.fn();
        const Sheet = shown.component;
        const sheet = await renderScreen(<Sheet {...shown.props} onClose={close} />);
        await act(async () => { await vi.waitFor(() => expect(sheet.findByTestId('machine-storage-review-row-wt-b')).not.toBeNull()); });
        for (const [itemId, title] of [['wt-a', 'issues-282'], ['wt-b', 'dev-post-snapshot']] as const) {
            const row = sheet.findHostByTestId(`machine-storage-review-row-${itemId}`);
            expect(row?.findAll(node => typeof node.type === 'string' && node.children.length === 1 && node.children[0] === title).length).toBeGreaterThan(0);
        }
        // Checked again by served reference only, even though the pile's own refs carry the machine's identity.
        expect(calls.find(call => call.method === RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK)?.payload?.refs).toEqual([
            { itemId: 'wt-a', path: ITEMS[0]!.path }, { itemId: 'wt-b', path: ITEMS[1]!.path }]);
        expect(sheet.getTextContent()).toContain('Move 2 items to Trash');

        // Approve 1 of 2: untick wt-b, then the Trash move carries exactly wt-a with its review token.
        await act(async () => { sheet.pressByTestId('machine-storage-review-row-wt-b'); });
        expect(sheet.getTextContent()).toContain('Move 1 item to Trash');
        await act(async () => { sheet.pressByTestId('machine-storage-review-confirm'); });
        await act(async () => { await vi.waitFor(() => expect(close).toHaveBeenCalled()); });
        const moved = calls.filter(call => call.method === RPC_METHODS.DAEMON_STORAGE_TRASH_MOVE);
        expect(moved).toHaveLength(1);
        expect(moved[0]!.payload).toMatchObject({ items: [{ ref: { itemId: 'wt-a' }, expect: 'expect-wt-a', claimedVerdict: 'safe' }] });
        expect((moved[0]!.payload!.items as unknown[]).length).toBe(1);

        // The pile bar becomes the result in place: in Trash (never "freed"), with Undo.
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-storage-pile-undo')).not.toBeNull()); });
        expect(screen.getTextContent()).toContain('1 item in Trash');
        expect(screen.getTextContent()).not.toContain('freed');

        // On the Trash page the page is the Trash: one Empty now in the page's own action spot, the last move's Undo
        // beside it, and a dock that keeps only the pile (what is still collected), never the Trash again.
        await act(async () => { setControlledParams!({ id: 'storage', page: 'category', categoryId: 'trash' }); });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-storage-trash-empty-all')).not.toBeNull()); });
        expect(screen.findByTestId('machine-storage-pile-empty')).toBeNull();
        expect(screen.findByTestId('machine-storage-pile-undo')).toBeNull();
        expect(screen.findByTestId('machine-storage-pile-review')).not.toBeNull();
        expect(screen.findByTestId('machine-storage-trash-undo')).not.toBeNull();
    });

    it('tells one count story when the check keeps an item where it is: title, sections and action agree', async () => {
        const pile = [resolved({ itemId: 'wt-a', path: '/Users/leeroy/dev/happier/.dev/worktree/a' }),
            resolved({ itemId: 'wt-b', path: '/Users/leeroy/dev/happier/.dev/worktree/b' })];
        const { screen } = await mount({ id: 'storage' }, {}, (rpc) => {
            switch (rpc.method) {
                case RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET: return { ...SUMMARY, pile: { count: 2, freesBytes: 3 * GB, droppedSinceLastView: [] } };
                case RPC_METHODS.DAEMON_STORAGE_PILE_GET: return { revision: 2, items: pile, summary: { count: 2, freesBytes: 3 * GB, droppedSinceLastView: [] } };
                case RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK: return {
                    items: [{ ref: pile[0], title: 'Merged clean worktree', expect: 'expect-a', verdict: 'safe', reason: { code: 'merged_clean' }, size: size(2 * GB), absorbs: [] }],
                    staying: [{ item: { itemId: 'wt-b', path: pile[1]!.path, title: 'Worktree with a running session' }, reason: { code: 'in_use' } }],
                    countedOnceBytes: 0, totalFreesBytes: 2 * GB, trashVolumes: [{ volumeId: 'mac', trashAvailable: true }] };
                default: return undefined;
            }
        });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-storage-pile-review')).not.toBeNull()); });
        await act(async () => { screen.pressByTestId('machine-storage-pile-review'); });
        const shown = modal.current!.spies.show.mock.calls.at(-1)?.[0] as { component: React.ComponentType<Record<string, unknown>>; props: Record<string, unknown> };
        const setChrome = vi.fn();
        const Sheet = shown.component;
        const sheet = await renderScreen(<Sheet {...shown.props} onClose={vi.fn()} setChrome={setChrome} />);
        await act(async () => { await vi.waitFor(() => expect(sheet.findByTestId('machine-storage-review-row-wt-a')).not.toBeNull()); });
        expect(setChrome.mock.calls.at(-1)?.[0]).toMatchObject({ title: 'Review 1 of 2 items' });
        expect(sheet.getTextContent()).toContain('Staying where it is · 1');
        expect(sheet.getTextContent()).toContain('Merged clean worktree');
        expect(sheet.getTextContent()).toContain('Worktree with a running session');
    });

    it('stops the session holding an in-use worktree, then reviews its changed facts before removal (R42.1)', async () => {
        const path = '/Users/leeroy/dev/happier/.dev/worktree/live';
        const pile = [resolved({ itemId: 'wt-live', path }), resolved({ itemId: 'wt-kept', path: `${path}-kept` })];
        const order: string[] = [];
        let stopped = false;
        let holderMetadata: Awaited<ReturnType<typeof holdingSession>> | undefined;
        const { screen, serverId } = await mount({ id: 'storage' }, {}, (rpc) => {
            const input = rpc.payload ?? {};
            switch (rpc.method) {
                case RPC_METHODS.STOP_SESSION:
                    expect(holderMetadata?.writes).toContain('sess-1');
                    order.push(`stop:${String(input.sessionId)}`);
                    stopped = true;
                    return { status: 'stopped' };
                case RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET: return { ...SUMMARY, pile: { count: 2, freesBytes: 4 * GB, droppedSinceLastView: [] } };
                case RPC_METHODS.DAEMON_STORAGE_PILE_GET: return { revision: 2, items: pile, summary: { count: 2, freesBytes: 4 * GB, droppedSinceLastView: [] } };
                case RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK:
                    if (stopped) order.push('check-stopped');
                    return {
                    items: [{ ref: pile[0], expect: stopped ? 'expect-stopped' : 'expect-live', verdict: stopped ? 'safe' : 'keep',
                        reason: stopped ? { code: 'stopped' } : { code: 'in_use', detail: { sessionId: 'sess-1' } },
                        loses: stopped ? [] : [{ code: 'in_use', detail: { sessionId: 'sess-1' } }], size: size(2 * GB), absorbs: [] },
                        { ref: pile[1], expect: 'expect-kept', verdict: 'safe', reason: { code: 'stopped' }, size: size(2 * GB), absorbs: [] }],
                    staying: [], countedOnceBytes: 0, totalFreesBytes: 4 * GB, trashVolumes: [{ volumeId: 'mac', trashAvailable: true }] };
                case RPC_METHODS.DAEMON_STORAGE_TRASH_MOVE:
                    expect(input.items).toMatchObject([{ ref: { itemId: 'wt-live' }, expect: 'expect-stopped' }]);
                    expect(input.items).toHaveLength(1);
                    order.push('move');
                    return { batchId: 'batch-live', mode: 'trash', inTrashBytes: 2 * GB, freedBytes: 0,
                        outcomes: (input.items as Array<{ ref: { itemId: string } }>).map(entry => ({ itemId: entry.ref.itemId, status: 'moved' })) };
                default: return undefined;
            }
        });
        holderMetadata = await holdingSession(serverId);
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-storage-pile-review')).not.toBeNull()); });
        await act(async () => { screen.pressByTestId('machine-storage-pile-review'); });
        const shown = modal.current!.spies.show.mock.calls.at(-1)?.[0] as { component: React.ComponentType<Record<string, unknown>>; props: Record<string, unknown> };
        const close = vi.fn();
        const Sheet = shown.component;
        const sheet = await renderScreen(<Sheet {...shown.props} onClose={close} />);
        await act(async () => { await vi.waitFor(() => expect(sheet.findByTestId('machine-storage-review-row-wt-live')).not.toBeNull()); });
        expect(sheet.getTextContent()).toContain('Stop the session and remove');
        await act(async () => { sheet.pressByTestId('machine-storage-review-row-wt-kept'); });
        await act(async () => { sheet.pressByTestId('machine-storage-review-confirm'); });
        await act(async () => { await vi.waitFor(() => expect(order).toEqual(['stop:sess-1', 'check-stopped'])); });
        expect(close).not.toHaveBeenCalled();
        await act(async () => { sheet.pressByTestId('machine-storage-review-confirm'); });
        await act(async () => { await vi.waitFor(() => expect(close).toHaveBeenCalled()); });
        expect(order).toEqual(['stop:sess-1', 'check-stopped', 'move']);
    });

    it.each(['daemon Stop', 'metadata write'] as const)('keeps an in-use worktree when its session does not stop, and says so (%s)', async failure => {
        const path = '/Users/leeroy/dev/happier/.dev/worktree/live';
        const pile = [resolved({ itemId: 'wt-live', path })];
        const calls: Rpc[] = [];
        const { screen, serverId } = await mount({ id: 'storage' }, {}, (rpc) => {
            calls.push(rpc);
            switch (rpc.method) {
                case RPC_METHODS.STOP_SESSION: return { status: 'incomplete', reason: 'runner_exit_timeout' };
                case RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET: return { ...SUMMARY, pile: { count: 1, freesBytes: 2 * GB, droppedSinceLastView: [] } };
                case RPC_METHODS.DAEMON_STORAGE_PILE_GET: return { revision: 2, items: pile, summary: { count: 1, freesBytes: 2 * GB, droppedSinceLastView: [] } };
                case RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK: return {
                    items: [{ ref: pile[0], expect: 'expect-live', verdict: 'keep', reason: { code: 'in_use', detail: { sessionId: 'sess-1' } },
                        size: size(2 * GB), absorbs: [] }],
                    staying: [], countedOnceBytes: 0, totalFreesBytes: 2 * GB, trashVolumes: [{ volumeId: 'mac', trashAvailable: true }] };
                default: return undefined;
            }
        });
        const holderMetadata = await holdingSession(serverId);
        if (failure === 'metadata write') holderMetadata.rejectNextPatch('sess-1');
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-storage-pile-review')).not.toBeNull()); });
        await act(async () => { screen.pressByTestId('machine-storage-pile-review'); });
        const shown = modal.current!.spies.show.mock.calls.at(-1)?.[0] as { component: React.ComponentType<Record<string, unknown>>; props: Record<string, unknown> };
        const close = vi.fn();
        const Sheet = shown.component;
        const sheet = await renderScreen(<Sheet {...shown.props} onClose={close} />);
        await act(async () => { await vi.waitFor(() => expect(sheet.findByTestId('machine-storage-review-row-wt-live')).not.toBeNull()); });
        await act(async () => { sheet.pressByTestId('machine-storage-review-confirm'); });
        await act(async () => { await vi.waitFor(() => expect(sheet.getTextContent()).toContain('The session didn’t stop')); });
        expect(holderMetadata.writes).toContain('sess-1');
        expect(calls.filter(call => call.method === RPC_METHODS.STOP_SESSION)).toHaveLength(failure === 'metadata write' ? 0 : 1);
        expect(calls.some(call => call.method === RPC_METHODS.DAEMON_STORAGE_TRASH_MOVE)).toBe(false);
        expect(close).not.toHaveBeenCalled();
    });

    it('lists a scanned folder in the whole-disk table with its honest marks and draws the same level as a Map', async () => {
        const node = (nodeId: string, parentId: string, bytes: number, extra: Record<string, unknown> = {}) => ({ nodeId, parentId, name: nodeId.split('/').pop(),
            kind: 'folder', size: size(bytes), logicalBytes: bytes, items: 12, changedAt: 1, deltaSincePrevious: 0,
            flags: { happier: false, protection: 'none', atLeast: false, inUse: false }, childCount: 0, ...extra });
        const scan = { scanId: 'scan-1', target: { volumeId: 'mac' }, status: 'complete', progress: { sizedBytes: 582 * GB, usedBytes: 582 * GB, items: 10 },
            startedAt: 1, finishedAt: 2, previousScanAt: Date.UTC(2026, 9, 7), unreadable: { counts: { permission: 0, os_private: 0, timeout: 0, io: 0 }, examples: [] },
            fullDiskAccess: { state: 'granted', binary: { name: 'happier-support', path: '/x' } } };
        const scanned = { ...SUMMARY, wholeDisk: { enabled: true, scans: [scan] } };
        const answer = (rpc: Rpc) => {
            if (rpc.method === RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET) return scanned;
            if (rpc.method === RPC_METHODS.DAEMON_STORAGE_PILE_GET) return { revision: 1, items: [], summary: SUMMARY.pile };
            if (rpc.method === RPC_METHODS.DAEMON_STORAGE_SCAN_GET) return { state: scan, coverage: [], nodes: [
                node('/Users', '/', 318 * GB), node('/Applications', '/', 86 * GB),
                node('/System', '/', 62 * GB, { flags: { happier: false, protection: 'forbidden', atLeast: false, inUse: false } }),
                node('/Volumes/Work', '/', 0, { kind: 'mount' }),
            ] };
            return undefined;
        };
        const { screen } = await mount({ id: 'storage', view: 'disk' }, {}, answer);
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-storage-disk-list')).not.toBeNull()); });
        await act(async () => { await vi.waitFor(() => expect(screen.getTextContent()).toContain('Applications')); });
        const text = screen.getTextContent();
        expect(text.indexOf('Users')).toBeLessThan(text.indexOf('Applications'));
        expect(text).toContain('Protected folder · you can look inside');
        expect(text).toContain('Another disk');
        expect(screen.findByTestId('machine-storage-disk-/Users-collect')).not.toBeNull();
        expect(screen.findByTestId('machine-storage-disk-/System-collect')).toBeNull();
        expect(text).toContain('Scanned');
        // Map is a picture of the same level above the list; the choice is remembered on this device.
        expect(screen.findByTestId('machine-storage-disk-map')).toBeNull();
        await act(async () => { screen.pressByTestId('machine-storage-disk-shape:map'); });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-storage-disk-map')).not.toBeNull()); });
        expect(screen.findByTestId('machine-storage-disk-list')).not.toBeNull();
        const scanReads = transport.rpc.mock.calls.map(call => call[0] as Rpc).filter(call => call.method === RPC_METHODS.DAEMON_STORAGE_SCAN_GET);
        expect(scanReads.at(-1)?.payload).toMatchObject({ view: { tab: 'folders', depth: 2 } });
        // Large files is a list only: the List · Map · Rings switch leaves rather than sitting disabled (lab MX).
        const large = await mount({ id: 'storage', view: 'disk', files: 'large' }, {}, answer);
        await act(async () => { await vi.waitFor(() => expect(large.screen.findByTestId('machine-storage-disk-files:large')).not.toBeNull()); });
        expect(large.screen.findByTestId('machine-storage-disk-shape:map')).toBeNull();
        // A phone keeps the list (STO-20): laid out at phone width, the view drops the switch.
        const phone = await mount({ id: 'storage', view: 'disk' }, {}, answer);
        await act(async () => { await vi.waitFor(() => expect(phone.screen.findByTestId('machine-storage-disk-shape:map')).not.toBeNull()); });
        const disk = phone.screen.root.find((entry) => entry.props.testID === 'machine-storage-disk' && typeof entry.type === 'string');
        await act(async () => { disk.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 358, height: 800 } } }); });
        expect(phone.screen.findByTestId('machine-storage-disk-shape:map')).toBeNull();
        // Opening a part keeps the chart drawn while the next level is read, so the drill can morph (lab MU).
        const drill = await mount({ id: 'storage', view: 'disk' }, {}, (rpc) => {
            const view = (rpc.payload as { view?: { nodeId?: string } } | undefined)?.view;
            if (rpc.method === RPC_METHODS.DAEMON_STORAGE_SCAN_GET && view?.nodeId === '/Users') return new Promise(() => {});
            return answer(rpc);
        }, true);
        await act(async () => { await vi.waitFor(() => expect(drill.screen.findByTestId('machine-storage-disk-shape:rings')).not.toBeNull()); });
        await act(async () => { drill.screen.pressByTestId('machine-storage-disk-shape:rings'); });
        await act(async () => { await vi.waitFor(() => expect(drill.screen.findByTestId('machine-storage-disk-rings')).not.toBeNull()); });
        await act(async () => { drill.screen.pressByTestId('machine-storage-disk-row-/Users'); });
        await act(async () => { await vi.waitFor(() => expect(transport.rpc.mock.calls.some(call =>
            (call[0] as Rpc).method === RPC_METHODS.DAEMON_STORAGE_SCAN_GET
            && ((call[0] as Rpc).payload as { view?: { nodeId?: string } } | undefined)?.view?.nodeId === '/Users')).toBe(true)); });
        expect(drill.screen.findByTestId('machine-storage-disk-rings')).not.toBeNull();
    });

    it('identifies the selected scan folder and its own allocation in List, Map and Rings', async () => {
        const folder = '/Users/leeroy/Development/archive';
        const scan = { scanId: 'folder-scan', target: { folderPath: folder }, status: 'complete',
            progress: { sizedBytes: 2 * GB, usedBytes: 582 * GB, items: 2 }, startedAt: 3, finishedAt: 4,
            unreadable: { counts: { permission: 0, os_private: 0, timeout: 0, io: 0 }, examples: [] },
            fullDiskAccess: { state: 'not_applicable', binary: { name: 'happier-support', path: '/x' } } };
        const previousVolumeScan = { ...scan, scanId: 'previous-volume-scan', target: { volumeId: 'mac' }, startedAt: 1 };
        const diskNode = (nodeId: string, parentId: string, bytes: number) => ({ nodeId, parentId,
            name: nodeId.split('/').pop()!, kind: 'folder', size: size(bytes), logicalBytes: bytes,
            items: 2, changedAt: 1, flags: { happier: false, protection: 'none', atLeast: false, inUse: false }, childCount: 1 });
        const { screen } = await mount({ id: 'storage', view: 'disk' }, {}, ({ method, payload }) => {
            if (method === RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET) return { ...SUMMARY, wholeDisk: { enabled: true, scans: [
                previousVolumeScan, scan,
            ] } };
            if (method === RPC_METHODS.DAEMON_STORAGE_PILE_GET) return { revision: 1, items: [], summary: SUMMARY.pile };
            if (method === RPC_METHODS.DAEMON_STORAGE_SCAN_GET && payload?.scanId === previousVolumeScan.scanId) return { state: previousVolumeScan, coverage: [], nodes: [] };
            if (method === RPC_METHODS.DAEMON_STORAGE_SCAN_GET) return { state: scan, coverage: [{ path: folder, scannedAt: 4, complete: true }],
                root: diskNode(folder, '/Users/leeroy/Development', 2 * GB), nodes: [diskNode(`${folder}/build`, folder, 2 * GB)] };
            return undefined;
        });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-storage-disk-list')).not.toBeNull()); });
        for (const shape of ['list', 'map', 'rings']) {
            await act(async () => { screen.pressByTestId(`machine-storage-disk-shape:${shape}`); });
            await act(async () => { await vi.waitFor(() => expect(screen.getTextContent()).toContain('archive holds 2 GB')); });
            const path = screen.findByTestId('machine-storage-disk-path')!;
            expect(path.findAll(node => node.children.includes('archive'))).not.toHaveLength(0);
            expect(screen.getTextContent()).toContain('2 GB');
            expect(screen.findByTestId(`machine-storage-disk-row-${folder}`)).toBeNull();
            expect(screen.findByTestId(`machine-storage-disk-row-${folder}/build`)).not.toBeNull();
        }
    });

    it('asks before a whole-disk Keep folder goes in the pile, naming what is lost, then collects it by served reference', async () => {
        const scan = { scanId: 'scan-1', target: { volumeId: 'mac' }, status: 'complete', progress: { sizedBytes: 582 * GB, usedBytes: 582 * GB, items: 10 },
            startedAt: 1, finishedAt: 2, unreadable: { counts: { permission: 0, os_private: 0, timeout: 0, io: 0 }, examples: [] },
            fullDiskAccess: { state: 'granted', binary: { name: 'happier-support', path: '/x' } } };
        const projects = { nodeId: '/Users/leeroy/projects', parentId: '/', name: 'projects', kind: 'folder', size: size(40 * GB), logicalBytes: 40 * GB,
            items: 12, changedAt: 1, flags: { happier: false, protection: 'keep', atLeast: false, inUse: false }, childCount: 0,
            reason: { code: 'contains', detail: { what: 'main_checkout' } }, loses: [{ code: 'changed_files', detail: { count: 3 } }] };
        const sets: Rpc[] = [];
        const { screen } = await mount({ id: 'storage', view: 'disk' }, {}, (rpc) => {
            if (rpc.method === RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET) return { ...SUMMARY, wholeDisk: { enabled: true, scans: [scan] } };
            if (rpc.method === RPC_METHODS.DAEMON_STORAGE_PILE_GET) return { revision: 1, items: [], summary: SUMMARY.pile };
            if (rpc.method === RPC_METHODS.DAEMON_STORAGE_SCAN_GET) return { state: scan, coverage: [], nodes: [projects] };
            if (rpc.method === RPC_METHODS.DAEMON_STORAGE_PILE_SET) {
                sets.push(rpc);
                return { revision: 2, items: [resolved({ itemId: projects.nodeId, path: projects.nodeId })], summary: { count: 1, freesBytes: 40 * GB, droppedSinceLastView: [] } };
            }
            return undefined;
        });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-storage-disk-list')).not.toBeNull()); });
        await act(async () => { await vi.waitFor(() => expect(screen.getTextContent()).toContain('projects')); });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-storage-disk-/Users/leeroy/projects-collect')).not.toBeNull()); });
        modal.current!.spies.confirm.mockClear();
        modal.current!.spies.confirm.mockResolvedValueOnce(true);
        await act(async () => { screen.pressByTestId('machine-storage-disk-/Users/leeroy/projects-collect'); });
        await act(async () => { await vi.waitFor(() => expect(modal.current!.spies.confirm).toHaveBeenCalled()); });
        expect(modal.current!.spies.confirm.mock.calls.at(-1)?.[1]).toContain('3 files with changes are lost.');
        await act(async () => { await vi.waitFor(() => expect(sets).toHaveLength(1)); });
        expect(sets[0]!.payload!.add).toEqual([{ itemId: '/Users/leeroy/projects', path: '/Users/leeroy/projects' }]);
    });

    it('after a move to Trash, says what comes back when the Trash empties instead of what can go (lab RD)', async () => {
        const moved = { ...SUMMARY, trash: { count: 6, allocatedBytes: 34.5 * GB, emptiesNextAt: Date.UTC(2026, 9, 17, 12) },
            volumes: SUMMARY.volumes.map((volume, index) => index === 0 ? { ...volume, trashBytes: 34.5 * GB } : volume) };
        const { screen } = await mount({ id: 'storage' }, {}, (rpc) => rpc.method === RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET ? moved : undefined);
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-storage-sentence')).not.toBeNull()); });
        expect(screen.getTextContent()).toContain('34.5 GB more comes back when the Trash empties on');
        expect(screen.getTextContent()).toContain('In the Trash');
    });

    it('invites a scan of the whole disk until the machine has one', async () => {
        const { screen } = await mount({ id: 'storage', view: 'disk' });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-storage-disk-invite')).not.toBeNull()); });
        expect(screen.getTextContent()).toContain('See everything on Macintosh HD');
        expect(screen.getTextContent()).toContain('Scan Macintosh HD');
    });

    it('offers the home folder beside Choose a folder and starts the same daemon scan on it', async () => {
        const calls: Rpc[] = [];
        const base = machine();
        const { screen } = await mount({ id: 'storage', view: 'disk' }, { metadata: { ...base.metadata!,
            resourcesPolicyV1: MachineResourcesPolicyV1Schema.parse({ v: 1, storage: { wholeDiskEnabled: true } }) } }, (rpc) => {
            calls.push(rpc);
            return undefined;
        });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-storage-disk-shortcut-0')).not.toBeNull()); });
        expect(screen.getTextContent()).toContain('/Users/leeroy');
        await act(async () => { screen.pressByTestId('machine-storage-disk-shortcut-0'); });
        await act(async () => { await vi.waitFor(() => expect(calls.some(call => call.method === RPC_METHODS.DAEMON_STORAGE_SCAN_START)).toBe(true)); });
        expect(calls.find(call => call.method === RPC_METHODS.DAEMON_STORAGE_SCAN_START)?.payload).toMatchObject({ target: { folderPath: '/Users/leeroy' } });
    });

    it.each(['/Volumes/Personal/Downloads', '/Volumes/Cache/user', '/Users/leeroy/projects/known'])(
        'starts daemon-supplied shortcuts and known project roots through the same scan Action: %s', async path => {
        const base = machine();
        const starts: unknown[] = [];
        const { screen, serverId } = await mount({ id: 'storage', view: 'disk' }, { metadata: { ...base.metadata!,
            resourcesPolicyV1: MachineResourcesPolicyV1Schema.parse({ v: 1, storage: { wholeDiskEnabled: true } }) } }, ({ method, payload }) => {
            if (method === RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET) return HappierStorageSummaryV1Schema.parse({ ...SUMMARY,
                scanShortcuts: [{ kind: 'downloads', path: '/Volumes/Personal/Downloads' }, { kind: 'cache', path: '/Volumes/Cache/user' }] });
            if (method === RPC_METHODS.DAEMON_STORAGE_SCAN_START) {
                const request = MachineStorageScanStartInputV1Schema.parse({ machineId: 'machine', ...payload });
                starts.push(request);
                return DiskScanStateV1Schema.parse({ scanId: 'shortcut-scan', target: request.target, status: 'running', startedAt: 1,
                    progress: { sizedBytes: 0, usedBytes: GB, items: 0 },
                    unreadable: { counts: { permission: 0, os_private: 0, timeout: 0, io: 0 }, examples: [] },
                    fullDiskAccess: { state: 'not_applicable', binary: { name: 'happier-support', path: '/x' } } });
            }
            return undefined;
        });
        await act(async () => { applyProjectAccountRowsFixture(storage, { workspaceRefs: [
            { id: 'project', serverId, machineId: 'machine', rootPath: '/Users/leeroy/projects/known', createdAtMs: 1 },
            { id: 'other-machine', serverId, machineId: 'other', rootPath: '/other-machine/private', createdAtMs: 1 },
            { id: 'other-home', serverId: 'other-home', machineId: 'machine', rootPath: '/other-home/private', createdAtMs: 1 },
        ] }); });
        await vi.waitFor(async () => { await act(async () => {}); expect(screen.findByTestId('machine-storage-disk-shortcut-0')).not.toBeNull(); });
        expect(screen.getTextContent()).not.toContain('/other-machine/private');
        expect(screen.getTextContent()).not.toContain('/other-home/private');
            const shortcut = screen.root.findAll(node => typeof node.type !== 'string'
                && node.props.testID?.startsWith('machine-storage-disk-shortcut-') && typeof node.props.onPress === 'function')
                .find(node => node.props.subtitle === (path.startsWith('/Users/leeroy') ? '~/projects/known' : path));
            expect(shortcut, `Missing shortcut ${path}`).toBeDefined();
            await act(async () => { shortcut!.props.onPress(); });
            await vi.waitFor(() => expect(starts).toContainEqual(expect.objectContaining({ target: { folderPath: path } })));
        expect(screen.findByTestId('machine-storage-disk')).not.toBeNull();
    });

    it.each([0, undefined])('renders only an observed read-only APFS snapshot count: %s', async count => {
        const scan = DiskScanStateV1Schema.parse({ scanId: 'apfs-scan', target: { volumeId: 'mac' }, status: 'complete', startedAt: 1, finishedAt: 2,
            ...(count === undefined ? {} : { apfsLocalSnapshotCount: count }),
            progress: { sizedBytes: GB, usedBytes: GB, items: 1 }, unreadable: { counts: { permission: 0, os_private: 0, timeout: 0, io: 0 }, examples: [] },
            fullDiskAccess: { state: 'not_applicable', binary: { name: 'happier-support', path: '/x' } } });
        const { screen } = await mount({ id: 'storage', view: 'disk' }, {}, ({ method }) => {
            if (method === RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET) return HappierStorageSummaryV1Schema.parse({ ...SUMMARY, wholeDisk: { enabled: true, scans: [scan] } });
            if (method === RPC_METHODS.DAEMON_STORAGE_PILE_GET) return { revision: 1, items: [], summary: SUMMARY.pile };
            if (method === RPC_METHODS.DAEMON_STORAGE_SCAN_GET) return { state: scan, coverage: [], nodes: [] };
            return undefined;
        });
        await vi.waitFor(async () => { await act(async () => {}); expect(screen.findByTestId('machine-storage-disk')).not.toBeNull(); });
        const note = screen.findByTestId('machine-storage-disk-apfs-snapshots');
        if (count === undefined) expect(note).toBeNull();
        else {
            expect(note).not.toBeNull();
            expect(note!.findAll(node => node.children.includes(t('machineStorage.disk.apfsLocalSnapshots', { count })))).not.toHaveLength(0);
        }
    });

    it.each(['map', 'rings'] as const)('copies the keyboard-inspected %s item after leaving the chart, including a deeper node', async shape => {
        clipboard.setStringAsync.mockClear();
        const scan: DiskScanStateV1 = { scanId: 'inspector-scan', target: { volumeId: 'mac' }, status: 'complete', startedAt: 1, finishedAt: 2,
            progress: { sizedBytes: GB, usedBytes: GB, items: 2 }, unreadable: { counts: { permission: 0, os_private: 0, timeout: 0, io: 0 }, examples: [] },
            fullDiskAccess: { state: 'not_applicable', binary: { name: 'happier-support', path: '/x' } } };
        const diskNode = (nodeId: string, parentId: string, bytes: number) => ({ nodeId, parentId, name: nodeId.split('/').pop(),
            kind: 'folder', size: size(bytes), logicalBytes: bytes, items: 1, changedAt: 1,
            flags: { happier: false, protection: 'none', atLeast: false, inUse: false }, childCount: 1 });
        const { screen } = await mount({ id: 'storage', view: 'disk' }, {}, ({ method }) => {
            if (method === RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET) return HappierStorageSummaryV1Schema.parse({ ...SUMMARY, wholeDisk: { enabled: true, scans: [scan] } });
            if (method === RPC_METHODS.DAEMON_STORAGE_PILE_GET) return { revision: 1, items: [], summary: SUMMARY.pile };
            if (method === RPC_METHODS.DAEMON_STORAGE_SCAN_GET) return { state: scan, coverage: [], nodes: [
                diskNode('/Users', '/', GB), diskNode('/Users/leeroy', '/Users', GB),
            ] };
            return undefined;
        });
        await vi.waitFor(async () => { await act(async () => {}); expect(screen.findByTestId(`machine-storage-disk-shape:${shape}`)).not.toBeNull(); });
        await act(async () => { screen.pressByTestId(`machine-storage-disk-shape:${shape}`); });
        await vi.waitFor(async () => { await act(async () => {}); expect(screen.findHostByTestId(`machine-storage-disk-${shape}`)).not.toBeNull(); });
        await act(async () => { screen.findHostByTestId(`machine-storage-disk-${shape}`)!.props.onLayout({ nativeEvent: { layout: { width: 792 } } }); });
        const chart = () => screen.root.find(node => typeof node.type === 'string' && node.props.accessibilityRole === 'image' && typeof node.props.onKeyDown === 'function');
        await act(async () => { chart().props.onKeyDown({ key: 'ArrowRight' }); });
        await act(async () => { chart().props.onKeyDown({ key: shape === 'rings' ? 'ArrowUp' : 'ArrowRight' }); });
        await act(async () => { chart().props.onPointerLeave(); });
        expect(screen.findByTestId('machine-storage-disk-inspector-copy')).not.toBeNull();
        await act(async () => { screen.pressByTestId('machine-storage-disk-inspector-copy'); });
        await vi.waitFor(() => expect(clipboard.setStringAsync).toHaveBeenCalledWith('/Users/leeroy'));
    });

    it('copies a scanned item’s exact machine path from its row actions, and offers none for folded space', async () => {
        const node = (nodeId: string, parentId: string, bytes: number, extra: Record<string, unknown> = {}) => ({ nodeId, parentId, name: nodeId.split('/').pop(),
            kind: 'folder', size: size(bytes), logicalBytes: bytes, items: 12, changedAt: 1, deltaSincePrevious: 0,
            flags: { happier: false, protection: 'none', atLeast: false, inUse: false }, childCount: 0, ...extra });
        const scan = { scanId: 'scan-1', target: { volumeId: 'mac' }, status: 'complete', progress: { sizedBytes: 582 * GB, usedBytes: 582 * GB, items: 10 },
            startedAt: 1, finishedAt: 2, unreadable: { counts: { permission: 0, os_private: 0, timeout: 0, io: 0 }, examples: [] },
            fullDiskAccess: { state: 'granted', binary: { name: 'happier-support', path: '/x' } } };
        const { screen } = await mount({ id: 'storage', view: 'disk' }, {}, (rpc) => {
            if (rpc.method === RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET) return { ...SUMMARY, wholeDisk: { enabled: true, scans: [scan] } };
            if (rpc.method === RPC_METHODS.DAEMON_STORAGE_PILE_GET) return { revision: 1, items: [], summary: SUMMARY.pile };
            if (rpc.method === RPC_METHODS.DAEMON_STORAGE_SCAN_GET) return { state: scan, coverage: [], nodes: [
                node('/Users', '/', 318 * GB), node('/small', '/', 1 * GB, { kind: 'small-items' }),
            ] };
            return undefined;
        });
        await act(async () => { await vi.waitFor(() => expect(screen.getTextContent()).toContain('Users')); });
        const rowActions = (key: string) => screen.findAllByProps({ testID: `machine-storage-disk-row-${key}` })
            .find(instance => typeof instance.props.onSecondaryAction === 'function');
        expect(rowActions('/small')).toBeUndefined();
        const users = rowActions('/Users');
        expect(users?.props.secondaryActions).toEqual([expect.objectContaining({ id: 'copy-path' })]);
        await act(async () => { users!.props.onSecondaryAction('copy-path'); });
        await act(async () => { await vi.waitFor(() => expect(clipboard.setStringAsync).toHaveBeenCalledWith('/Users')); });
    });

    it('says the machine is offline on an unscanned whole disk instead of an invite it cannot start', async () => {
        const { screen, serverId } = await mount({ id: 'storage', view: 'disk' });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-storage-disk-invite')).not.toBeNull()); });
        await act(async () => {
            storage.setState({ machineListByServerId: { [serverId]: [machine({ active: false, activeAt: Date.now() - 60 * 60_000 })] } });
        });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-storage-disk-offline')).not.toBeNull()); });
        expect(screen.findByTestId('machine-storage-disk-invite')).toBeNull();
        expect(screen.getTextContent()).not.toContain('Other disks are scanned on their own');
    });

    it('empties the Trash from its row after one confirmation that says it can’t be undone', async () => {
        const withTrash = { ...SUMMARY, categories: [...SUMMARY.categories,
            { categoryId: 'trash' as const, size: size(34.5 * GB), canGoBytes: 0, count: 6, detailFacts: {} }],
            trash: { count: 6, allocatedBytes: 34.5 * GB, emptiesNextAt: Date.UTC(2026, 9, 17) } };
        const calls: Rpc[] = [];
        const { screen } = await mount({ id: 'storage' }, {}, (rpc) => {
            calls.push(rpc);
            if (rpc.method === RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET) return withTrash;
            if (rpc.method === RPC_METHODS.DAEMON_STORAGE_TRASH_EMPTY) return { outcomes: [], freedBytes: 34.5 * GB };
            return undefined;
        });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-storage-category-trash-empty')).not.toBeNull()); });
        await act(async () => { screen.pressByTestId('machine-storage-category-trash-empty'); });
        await act(async () => { await vi.waitFor(() => expect(modal.current!.spies.confirm).toHaveBeenCalled()); });
        expect(calls.some(call => call.method === RPC_METHODS.DAEMON_STORAGE_TRASH_EMPTY)).toBe(false);
        modal.current!.spies.confirm.mockResolvedValueOnce(true);
        await act(async () => { screen.pressByTestId('machine-storage-category-trash-empty'); });
        await act(async () => { await vi.waitFor(() => expect(calls.some(call => call.method === RPC_METHODS.DAEMON_STORAGE_TRASH_EMPTY)).toBe(true)); });
    });
});
