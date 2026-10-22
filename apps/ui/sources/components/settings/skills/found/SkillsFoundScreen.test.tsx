import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { SkillFoundListResultV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { act, createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSkillsSurfaceHarness } from '@/dev/testkit/harness/skillsSurfaceHarness';
import type { FoundMachineScan } from '@/sync/domains/skills/useFoundSkills';
import type { ReachMachine } from '@/sync/domains/capabilities/reach/useReachProjection';

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
installDisconnectedServerSocketBoundary();
const { SkillsFoundPage, SkillsFoundScreen } = await import('./SkillsFoundScreen');
const { saveFoundWarmCacheEntry } = await import('@/sync/domains/state/warmCachePersistence');
const { prepareWarmCacheEncryptionKey } = await import('@/sync/domains/state/warmCacheEncryptionKey');
const { resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const { resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
afterEach(() => { standardCleanup(); resetPromptLibraryCatalogEngineForTests(); resetPromptLibraryCatalogSnapshotsForTests(); });

const result = SkillFoundListResultV1Schema.parse({ scannedAt: 123, roots: [], items: [
    ...['one', 'two', 'held', 'plugin', 'masked'].map(name => ({ name, description: null, path: `/skills/${name}`, digest: name,
        agents: ['codex'], scope: 'user', inLibrary: name === 'held' ? 'library-held' : null, masksLibrary: name === 'masked',
        happierInstalled: false, pluginOwned: name === 'plugin' ? { pluginName: 'review-kit' } : null })),
] });
const machine = (machineId: string, offline = false): ReachMachine => ({ machineId, name: machineId,
    platform: 'posix', agentIds: ['codex'], online: !offline, offline, lastSeenAt: offline ? 123 : null });

it('bulk-adds only addable native rows, retains their positions while settling, and offers plugin copy and masked Compare', async () => {
    const home = await createSkillsSurfaceHarness('https://skills-found-page.test');
    try {
        const pending = createDeferred<Awaited<ReturnType<React.ComponentProps<typeof SkillsFoundPage>['adopt']>>>();
        const adopted: string[][] = [];
        const adopt: React.ComponentProps<typeof SkillsFoundPage>['adopt'] = async (_machineId, items) => {
            adopted.push(items.map(item => item.name)); return pending.promise;
        };
        let scan: FoundMachineScan = { machineId: 'nl2', result, scanning: false, failure: null };
        const onScan = async () => { scan = { ...scan, result: { ...result,
            items: result.items.map(item => item.name === 'one' || item.name === 'two' ? { ...item, inLibrary: `library-${item.name}` } : item) } }; };
        const props: React.ComponentProps<typeof SkillsFoundPage> = { machines: [machine('nl2')], scanOf: () => scan,
            canCheckAgain: true, checking: false, onCheckAgain: () => {}, libraryIdByName: new Map([['masked', 'library-masked']]),
            libraryPending: false, agentNames: ids => ids, onScan, adopt, readBoth: async () => null };
        const screen = await renderScreen(<SkillsFoundPage {...props} />);
        expect(screen.findByTestId('skills.found.action.nl2.plugin')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Make a copy');
        expect(screen.findByTestId('skills.found.action.nl2.masked')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Compare');
        const rows = () => screen.findAll(node => typeof node.type === 'string' && typeof node.props.testID === 'string'
            && node.props.testID.startsWith('skills.found.row.')).map(node => node.props.testID);
        const before = rows();
        expect(before).toHaveLength(5);
        await act(async () => screen.pressByTestId('skills.found.addAll.nl2'));
        expect(adopted).toEqual([['one', 'two']]);
        expect(screen.findByTestId('skills.found.action.nl2.one')?.props.disabled).toBe(true);
        await act(async () => pending.resolve({ skillIds: ['library-one', 'library-two'], incomplete: false }));
        await screen.update(<SkillsFoundPage {...props} scanOf={() => scan} />);
        expect(rows()).toEqual(before);
        expect(screen.findByTestId('skills.found.addAll.nl2')).toBeNull();
        expect(screen.findByTestId('skills.found.action.nl2.one')?.findAll(node => node.children.includes('In your library'))).not.toHaveLength(0);
    } finally { await standardCleanup(); await home.dispose(); }
});

it('keeps last-known rows offline with Add disabled and a recovery reason', async () => {
    const home = await createSkillsSurfaceHarness('https://skills-found-offline.test');
    try {
        const away = home.storage.getState().machines.away!;
        home.storage.setState({ machines: { away }, machineListByServerId: { [home.scope.serverId]: [away] } });
        await prepareWarmCacheEncryptionKey();
        saveFoundWarmCacheEntry(home.scope.serverId, home.scope.accountId,
            { kind: 'skill', machineId: 'away', observedAt: result.scannedAt, result });
        const screen = await renderScreen(<SkillsFoundScreen />);
        await vi.waitFor(() => expect(screen.findByTestId('skills.found.row.away.one')).not.toBeNull());
        expect(screen.findByTestId('skills.found.offline.away')).not.toBeNull();
        expect(screen.findByTestId('skills.found.action.away.one')?.props.disabled).toBe(true);
        expect(screen.findByTestId('skills.found.addAll.away')).toBeNull();
        expect(screen.getTextContent()).toContain('Bring away online');
        expect(screen.findByTestId('skills.found.checkAgain')).toBeNull();
    } finally { await standardCleanup(); await home.dispose(); }
});
