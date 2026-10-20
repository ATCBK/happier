import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardItemRefV1 } from '@happier-dev/protocol';
import { buildWorkBoardItemKeyV1 } from '@happier-dev/protocol/boards/workBoardV1';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => (params && 'count' in params ? `${key}:${String(params.count)}` : key),
    });
});

import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';

import {
    buildBoardCards,
    createBoardCardProjection,
    countSessionsByMachine,
    describeBoardColumnLine,
    reconcileBoardCards,
    type BoardCardFacts,
} from './boardCards';
import type { BoardMember } from './boardMembership';
import { readSessionStatusNextRefreshAtMs } from '@/utils/sessions/sessionUtils';
import { clearMachineRequestReachabilityForTest, recordMachineRequestFailed, recordMachineRequestSucceeded } from '@/sync/domains/machines/reachability/machineReachability';
import { adoptHomeProfile } from '@/sync/domains/server/serverProfiles';
import { readBoardMachineSourceState, readBoardPagedEntitySourceState, readBoardSessionSourceState, shouldLoadNextBoardEntityPage } from './boardEntityBinding';

const NOW = 1_000_000;
afterEach(clearMachineRequestReachabilityForTest);

function member(ref: BoardItemRefV1, available = true): BoardMember {
    return { key: buildWorkBoardItemKeyV1(ref), ref, picked: true, sourced: false, available };
}

const permissionSession = createSessionListRenderableSessionFixture({
    id: 's-need',
    active: true,
    activeAt: NOW,
    hasPendingPermissionRequests: true,
    pendingRequestObservedAt: NOW,
    metadata: { path: '/repo', host: 'mbp', homeDir: '/u', machineId: 'm1' },
});
const workingSession = createSessionListRenderableSessionFixture({
    id: 's-work',
    active: true,
    activeAt: NOW,
    thinking: true,
    thinkingAt: NOW,
    metadata: { path: '/repo', host: 'mbp', homeDir: '/u', machineId: 'm1' },
});

describe('board cards', () => {
    it('settles linked-task status with its Session read and recovers without replacing the task', () => {
        const ref = { kind: 'task', qualifiedId: { serverId: 'home-a', id: 'issue-cold' }, pluginId: 'com.acme.tasks' } as const;
        const task = { title: 'Cold linked work', category: 'completed' as const,
            linkedSessions: [{ serverId: 'home-a', sessionId: permissionSession.id }] };
        const facts: BoardCardFacts = { nowMs: NOW, session: () => null, task: () => task,
            workflowRun: () => null, machine: () => null, workflow: () => null,
            machineSessionCounts: new Map(), accountScopedHome: () => true };
        const project = createBoardCardProjection();
        expect(project([member(ref)], facts)[0]?.status.bucket).toBe('idle');
        const settled = { ...facts, missingEntityReason: (item: BoardItemRefV1) => item.kind === 'session' ? 'read failed' : null };
        expect(project([member(ref)], settled)[0]).toMatchObject({ availability: 'ready', title: task.title,
            status: { bucket: 'offline' } });
        expect(project([member(ref)], { ...settled, session: () => permissionSession })[0]?.status.bucket).toBe('needs_you');
    });

    it('keeps external task cards, uses linked-agent status, and refreshes that status without changing task facts', () => {
        const ref = { kind: 'task', qualifiedId: { serverId: 'home-a', id: 'issue-7' }, pluginId: 'com.acme.tasks' } as const;
        const task = { title: 'Fix payments', category: 'backlog' as const, categoryLabel: 'Backlog',
            linkedSessions: [{ serverId: 'home-a', sessionId: permissionSession.id }] };
        const facts: BoardCardFacts = { nowMs: NOW, session: () => permissionSession, workflowRun: () => null,
            machine: () => null, workflow: () => null, machineSessionCounts: new Map(), accountScopedHome: () => true,
            task: () => task };
        const project = createBoardCardProjection();
        const cards = project([member(ref)], facts);
        expect(cards[0]).toMatchObject({ title: 'Fix payments', availability: 'ready', status: { bucket: 'needs_you' } });
        expect(project([member(ref)], { ...facts, session: () => workingSession })[0]?.status.bucket).toBe('working');
        expect(buildBoardCards([member(ref)], { ...facts, task: () => ({ ...task, linkedSessions: [] }) })[0]?.status)
            .toMatchObject({ bucket: 'idle', word: 'Backlog' });
        const unavailable = buildBoardCards([member(ref)], { ...facts, task: () => null,
            missingEntityReason: () => 'boards.card.unavailable' })[0];
        expect(unavailable).toMatchObject({ ref, availability: 'content_unavailable' });
    });

    it('binds Session settlement to its exact Home while retaining a real row over a tombstone', async () => {
        const serverId = 'srv_board_source';
        const profile = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: serverId,
            canonicalServerUrl: 'https://board-source.example.test', revision: 1,
            endpoints: [{ kind: 'https', url: 'https://board-source.example.test' }],
        }, source: 'manual' });
        const ref = { kind: 'session' as const, qualifiedId: { serverId, id: 'uncached' } };
        const cold = { sessionListRowsByServerId: {}, deletedSessionIds: {}, concurrentSessionListCacheByServerId: {} };
        expect(readBoardSessionSourceState(cold, ref)).toBe('loading');
        expect(readBoardSessionSourceState({ ...cold, deletedSessionIds: { uncached: 'other' }, concurrentSessionListCacheByServerId: {
            other: { serverName: null, listObservation: { phase: 'ready', lastSuccessAt: 1 } },
        } }, ref)).toBe('loading');
        const warm = { ...cold, concurrentSessionListCacheByServerId: {
            [profile.id]: { serverName: null, listObservation: { phase: 'refreshing' as const, lastSuccessAt: 1 } },
        } };
        expect(readBoardSessionSourceState(warm, ref)).toBe('settled');
        expect(readBoardSessionSourceState({ ...cold, deletedSessionIds: { uncached: profile.id } }, ref)).toBe('retired');
        const row = createSessionListRenderableSessionFixture({ id: ref.qualifiedId.id, archivedAt: 1 });
        expect(readBoardSessionSourceState({ ...cold, deletedSessionIds: { uncached: profile.id },
            sessionListRowsByServerId: { [profile.id]: { [row.id]: row } },
        }, ref)).toBe('ready');
        expect(readBoardSessionSourceState({ ...cold, concurrentSessionListCacheByServerId: {
            [serverId]: { serverName: null, listObservation: { phase: 'error', lastSuccessAt: null } },
        } }, ref)).toBe('failed');
    });

    it('binds Machine settlement to applied canonical inventory and retains its cached row during refresh', () => {
        const ref = { kind: 'machine' as const, qualifiedId: { serverId: 'home-a', id: 'machine' } };
        expect(readBoardMachineSourceState({ machineListByServerId: { 'home-a': null },
            machineListStatusByServerId: { 'home-a': 'loading' } }, ref)).toBe('loading');
        expect(readBoardMachineSourceState({ machineListByServerId: { 'home-a': [] },
            machineListStatusByServerId: { 'home-a': 'idle' } }, ref)).toBe('settled');
        expect(readBoardMachineSourceState({ machineListByServerId: { 'home-a': [createMachineFixture({ id: 'machine' })] },
            machineListStatusByServerId: { 'home-a': 'loading' } }, ref)).toBe('ready');
        expect(readBoardMachineSourceState({ machineListByServerId: { 'home-a': null },
            machineListStatusByServerId: { 'home-a': 'signedOut' } }, ref)).toBe('settled');
    });

    it('keeps Workflow and Run refs loading through pages and settles exhausted or failed readers', () => {
        const source = { status: 'loaded' as const, hasMore: true, loadingMore: false, loadMoreFailed: false };
        expect(readBoardPagedEntitySourceState(source)).toBe('loading');
        expect(shouldLoadNextBoardEntityPage(source, true)).toBe(true);
        expect(shouldLoadNextBoardEntityPage(source, false)).toBe(false);
        expect(shouldLoadNextBoardEntityPage({ ...source, loadingMore: true }, true)).toBe(false);
        expect(readBoardPagedEntitySourceState({ ...source, hasMore: false })).toBe('settled');
        const failed = { ...source, loadMoreFailed: true };
        expect(readBoardPagedEntitySourceState(failed)).toBe('settled');
        expect(shouldLoadNextBoardEntityPage(failed, true)).toBe(false);
        expect(readBoardPagedEntitySourceState({ ...source, status: 'failed' })).toBe('settled');
    });

    it('reprojects request failure and recovery for the machine own Home and Account without a machine row update', () => {
        const ref = { kind: 'machine', qualifiedId: { serverId: 'home-a', id: 'mbp' } } as const;
        const machine = createMachineFixture({ id: 'mbp', active: true, activeAt: NOW });
        const scope = { serverId: 'home-a', accountId: 'owner' };
        const facts: BoardCardFacts = { nowMs: NOW, session: () => null, workflowRun: () => null, workflow: () => null,
            machine: () => machine, machineScope: () => scope, machineSessionCounts: new Map(), accountScopedHome: () => true };
        const project = createBoardCardProjection();
        expect(project([member(ref)], facts)[0]?.body).toMatchObject({ online: true });
        recordMachineRequestFailed({ ...scope, machineId: machine.id, observedAtMs: NOW });
        expect(project([member(ref)], facts)[0]?.body).toMatchObject({ online: false });
        expect(project([member(ref)], facts)[0]?.status.bucket).toBe('offline');
        recordMachineRequestSucceeded({ ...scope, machineId: machine.id, observedAtMs: NOW + 1 });
        expect(project([member(ref)], facts)[0]?.body).toMatchObject({ online: true });
        expect(project([member(ref)], { ...facts, machineScope: () => null })[0]?.body).toMatchObject({ online: false });
    });
    it('keeps the enrolled Machine asleep and reprojects observed Start through the shared status owner', () => {
        const ref = { kind: 'machine', qualifiedId: { serverId: 'home-a', id: 'guest' } } as const;
        const managed: ManagedMachineV1 = { id: 'managed', homeId: 'home-a', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.native', localId: 'vm' }, schemaVersion: 1, name: 'Build box', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, enrolledMachineId: 'guest',
            allocation: 'bound', creationState: 'active', desired: 'stop', desiredWhen: 'now', intentRevision: 1,
            resource: { contributionRef: { pluginId: 'custom.native', localId: 'vm' }, schemaVersion: 1, value: { id: 'retained-native' } },
            retention: { kind: 'unused', afterMs: 3600000, effect: 'stop' }, wakeOnAcceptedMessage: true,
            observation: { observedAt: 10, availability: 'present', power: 'stopped', storage: 'retained', daemon: 'disconnected' } };
        const guest = createMachineFixture({ id: 'guest', active: false, activeAt: 0 });
        const members = [member(ref)];
        const facts: BoardCardFacts = { nowMs: NOW, session: () => null, workflowRun: () => null, workflow: () => null,
            machine: () => guest, managedMachine: () => managed,
            machineSessionCounts: new Map(), accountScopedHome: () => true };
        const project = createBoardCardProjection();
        expect(project(members, facts)[0]?.status).toMatchObject({ bucket: 'idle', word: 'managedPower.asleep' });
        const starting = { ...managed, submittedNativeEffect: { intent: 'start' as const, intentRevision: 2, requestId: 'start', controller: managed.controller } };
        expect(project(members, { ...facts, managedMachine: () => starting })[0]?.status).toMatchObject({ bucket: 'working', word: 'managedWake.starting' });
    });
    it('names why an online Machine needs the person in its state word, not its presence', () => {
        const ref = { kind: 'machine', qualifiedId: { serverId: 'home-a', id: 'mbp' } } as const;
        const mbp = createMachineFixture({ id: 'mbp', active: true, activeAt: NOW });
        const facts: BoardCardFacts = { nowMs: NOW, session: () => null, workflowRun: () => null, workflow: () => null,
            machine: () => mbp, machineScope: () => ({ serverId: 'home-a', accountId: 'owner' }), machineSessionCounts: new Map([[member(ref).key, { running: 2, needsYou: 1 }]]), accountScopedHome: () => true };
        expect(buildBoardCards([member(ref)], facts)[0]?.status)
            .toEqual({ bucket: 'needs_you', tone: 'attention', word: 'boards.card.machine.needYou:1' });
        const calm = buildBoardCards([member(ref)], { ...facts, machineSessionCounts: new Map([[member(ref).key, { running: 2, needsYou: 0 }]]) });
        expect(calm[0]?.status).toEqual({ bucket: 'working', tone: 'neutral', word: 'boards.card.machine.online' });
    });
    it('keeps unreadable Session explanations in the body with a short neutral state word', () => {
        const row = createSessionListRenderableSessionFixture({ ...permissionSession, metadata: null,
            encryptionMode: 'e2ee', encryptedContentAvailability: 'encrypted_content_unavailable' });
        const [card] = buildBoardCards([member({ kind: 'session', qualifiedId: { serverId: 'home-a', id: row.id } })], {
            nowMs: NOW, session: () => row, workflowRun: () => null, machine: () => null,
            workflow: () => null, machineSessionCounts: new Map(), accountScopedHome: () => true,
        });
        expect(card?.status).toMatchObject({ bucket: 'idle', tone: 'neutral', word: 'boards.card.unavailable' });
        expect(card?.body).toMatchObject({ kind: 'session', statusDetail: 'session.access.unavailable' });
        // No readable title exists, so the card is named by its kind rather than by a placeholder session name.
        expect(card?.title).toBe('boards.kinds.session');
    });
    it('gives an unreadable Session of unknown state one reason instead of a bare Unavailable', () => {
        const row = createSessionListRenderableSessionFixture({ ...permissionSession, metadata: null,
            encryptionMode: 'e2ee', encryptedContentAvailability: null });
        const [card] = buildBoardCards([member({ kind: 'session', qualifiedId: { serverId: 'home-a', id: row.id } })], {
            nowMs: NOW, session: () => row, workflowRun: () => null, machine: () => null,
            workflow: () => null, machineSessionCounts: new Map(), accountScopedHome: () => true,
        });
        expect(card?.title).toBe('boards.kinds.session');
        expect(card?.status.word).toBe('boards.card.unavailable');
        expect(card?.body).toMatchObject({ kind: 'session', statusDetail: 'boards.card.readFailed' });
    });
    it('reprojects unchanged Session sources when the canonical status freshness deadline passes', () => {
        const members = [member({ kind: 'session', qualifiedId: { serverId: 'home-a', id: permissionSession.id } })];
        const facts: BoardCardFacts = { nowMs: NOW, session: () => permissionSession, workflowRun: () => null,
            machine: () => null, workflow: () => null, machineSessionCounts: new Map(), accountScopedHome: () => true };
        const project = createBoardCardProjection();
        const before = project(members, facts);
        expect(before[0]?.status.bucket).toBe('needs_you');
        const refreshAt = readSessionStatusNextRefreshAtMs(permissionSession, NOW);
        expect(refreshAt).not.toBeNull();
        const expired = { ...facts, nowMs: refreshAt! };
        expect(project(members, expired)[0]?.status).toEqual(buildBoardCards(members, expired)[0]?.status);
        expect(project(members, expired)[0]?.status.bucket).not.toBe('needs_you');
    });
    it('projects FIN lean authored-step and loop progress without opening full runs', () => {
        const ref = { kind: 'workflow_run', qualifiedId: { serverId: 'home-a', id: 'r1' } } as const;
        const facts: BoardCardFacts = {
            nowMs: NOW, session: () => null, machine: () => null, machineSessionCounts: new Map(),
            workflow: () => null, accountScopedHome: () => true,
            workflowRun: () => workflowRunRowFromSummary(createWorkflowRunSummaryFixture({
                stepProgress: { completed: 3, total: 5, currentLoop: { completed: 2, total: 8 } },
            }), null),
        };
        expect(buildBoardCards([member(ref)], facts)[0]?.body).toMatchObject({
            kind: 'workflow_run', progress: { completed: 3, total: 5, currentLoop: { completed: 2, total: 8 } },
        });
        const missing = buildBoardCards([member(ref)], { ...facts,
            workflowRun: () => workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ stepProgress: null }), null) });
        expect(missing[0]?.body).toMatchObject({ progress: null });
    });

    it('projects library trigger summaries and distinguishes manual from unavailable scheduled next-run facts', () => {
        const ref = { kind: 'workflow', qualifiedId: { serverId: 'home-a', id: 'wf1' } } as const;
        const facts: BoardCardFacts = {
            nowMs: NOW, session: () => null, machine: () => null, machineSessionCounts: new Map(),
            workflowRun: () => null, accountScopedHome: () => true,
            workflow: () => ({ title: 'Nightly', triggers: [{ kind: 'schedule', schedule: {
                kind: 'interval', everyMs: 3_600_000, scheduleExpr: null, timezone: null,
            } }], summary: { needsYouCount: 2, lastRun: { state: 'succeeded', createdAt: '2026-10-01T00:00:00Z' } } }),
        };
        expect(buildBoardCards([member(ref)], facts)[0]?.body).toMatchObject({
            triggerSummary: 'workflows.triggers.summary.everyHours:1', nextRun: { kind: 'unavailable' }, needsYouCount: 2,
        });
        const notRead = buildBoardCards([member(ref)], { ...facts, workflow: () => ({ title: 'Manual', triggers: [], summary: null }) })[0];
        expect(notRead?.body)
            .toMatchObject({ triggerSummary: 'workflows.triggers.summary.manual', nextRun: { kind: 'unscheduled' }, needsYouCount: null });
        expect(notRead?.status.word).toBe('common.loading');
    });

    it('reads an item this device has not loaded yet as loading, and keeps "unavailable" for a Home that is not connected', () => {
        const ref = { kind: 'session', qualifiedId: { serverId: 'home-a', id: 's-late' } } as const;
        const facts: BoardCardFacts = {
            nowMs: NOW, session: () => null, workflowRun: () => null, workflow: () => null,
            machine: () => null, machineSessionCounts: new Map(), accountScopedHome: () => true,
        };
        // While the Session row is still arriving the card does not claim the item is unavailable.
        expect(buildBoardCards([member(ref)], facts)[0]).toMatchObject({
            availability: 'not_loaded', title: 'common.loading', status: { word: 'common.loading' },
        });
        expect(buildBoardCards([member(ref, false)], facts)[0]).toMatchObject({
            availability: 'home_unavailable', title: 'boards.kinds.session', status: { word: 'boards.card.unavailable' },
        });
    });

    it('reprojects an absent entity when its binding settles without inventing a row', () => {
        const ref = { kind: 'session', qualifiedId: { serverId: 'home-a', id: 's-missing' } } as const;
        const members = [member(ref)];
        const facts: BoardCardFacts = {
            nowMs: NOW, session: () => null, workflowRun: () => null, workflow: () => null,
            machine: () => null, machineSessionCounts: new Map(), accountScopedHome: () => true,
        };
        const project = createBoardCardProjection();
        expect(project(members, facts)[0]?.availability).toBe('not_loaded');
        const settled = { ...facts, missingEntityReason: () => 'source answered without this item' };
        expect(project(members, settled)[0]).toMatchObject({ availability: 'content_unavailable',
            unavailableReason: 'source answered without this item', status: { bucket: 'offline', word: 'boards.card.unavailable' }, body: { kind: 'none' } });
        const row = createSessionListRenderableSessionFixture({ id: ref.qualifiedId.id });
        expect(project(members, { ...settled, session: () => row })[0]?.availability).toBe('ready');
    });

    it('counts running and needs-you sessions per machine from the loaded rows, through the shared status owner', () => {
        const machineKey = (serverId: string, id: string) => JSON.stringify(['machine', serverId, id]);
        // The same machine id on two Homes is two machines: each counts only its own Home's rows.
        const counts = countSessionsByMachine([
            ['home-a', [permissionSession, workingSession]],
            ['home-b', [{ ...workingSession, id: 's-work-b' }]],
        ], NOW);
        expect(counts.get(machineKey('home-a', 'm1'))).toEqual({ running: 1, needsYou: 1 });
        expect(counts.get(machineKey('home-b', 'm1'))).toEqual({ running: 1, needsYou: 0 });
    });

    it('gives every kind one status vocabulary and groups all kinds By status, Finished rather than Done', () => {
        const facts: BoardCardFacts = {
            nowMs: NOW,
            session: (ref) => (ref.qualifiedId.id === 's-need' ? permissionSession : null),
            workflowRun: () => workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'r1', state: 'succeeded' }), null),
            machine: (ref) => (ref.qualifiedId.id === 'm1'
                ? createMachineFixture({ id: 'm1', active: true, activeAt: NOW })
                : createMachineFixture({ id: 'm2', active: false, activeAt: 1 })),
            machineScope: serverId => ({ serverId, accountId: 'owner' }),
            machineSessionCounts: new Map([[JSON.stringify(['machine', 'home-a', 'm1']), { running: 1, needsYou: 1 }]]),
            accountScopedHome: () => true,
            workflow: () => ({ title: 'Nightly release check', summary: { needsYouCount: 0, lastRun: null } }),
        };
        const cards = buildBoardCards([
            member({ kind: 'session', qualifiedId: { serverId: 'home-a', id: 's-need' } }),
            member({ kind: 'workflow_run', qualifiedId: { serverId: 'home-a', id: 'r1' } }),
            member({ kind: 'machine', qualifiedId: { serverId: 'home-a', id: 'm1' } }),
            member({ kind: 'machine', qualifiedId: { serverId: 'home-a', id: 'm2' } }),
            member({ kind: 'workflow', qualifiedId: { serverId: 'home-a', id: 'wf1' } }),
        ], facts);

        expect(cards.map((card) => [card.ref.kind, card.status.bucket])).toEqual([
            ['session', 'needs_you'],
            ['workflow_run', 'finished'],
            ['machine', 'needs_you'],
            ['machine', 'offline'],
            ['workflow', 'idle'],
        ]);
    });

    it('shows an item from a Home that is not mounted as unavailable, not as missing work', () => {
        const [card] = buildBoardCards([member({ kind: 'session', qualifiedId: { serverId: 'home-off', id: 's9' } }, false)], {
            nowMs: NOW,
            session: () => null,
            workflowRun: () => null,
            machine: () => null,
            machineSessionCounts: new Map(),
            workflow: () => null,
            accountScopedHome: () => true,
        });
        expect(card!.availability).toBe('home_unavailable');
        expect(card!.status.bucket).toBe('offline');
    });

    it('never reads another Home\'s workflow or run from the focused Home\'s same-id item', () => {
        const run = (serverId: string) => member({ kind: 'workflow_run', qualifiedId: { serverId, id: 'r1' } });
        const workflow = (serverId: string) => member({ kind: 'workflow', qualifiedId: { serverId, id: 'wf1' } });
        const cards = buildBoardCards([run('home-a'), run('home-b'), workflow('home-a'), workflow('home-b')], {
            nowMs: NOW,
            session: () => null,
            // The Account-scoped stores hold the focused Home's (home-a) r1 and wf1, keyed by bare id.
            workflowRun: () => workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'r1', state: 'running' }), null),
            machine: () => null,
            machineSessionCounts: new Map(),
            workflow: () => ({ title: 'Nightly release check', summary: { needsYouCount: 0, lastRun: null } }),
            accountScopedHome: (serverId) => serverId === 'home-a',
        });
        expect(cards.map((card) => [card.ref.qualifiedId.serverId, card.ref.kind, card.availability])).toEqual([
            ['home-a', 'workflow_run', 'ready'],
            ['home-b', 'workflow_run', 'home_unavailable'],
            ['home-a', 'workflow', 'ready'],
            ['home-b', 'workflow', 'home_unavailable'],
        ]);
    });

    it('on a populated board, a store update on one item gives a new card to that item only', () => {
        // 40 cards mixing kinds (INT §7.3); one Session then asks for a permission.
        const rows = new Map(Array.from({ length: 20 }, (_, index) => [`s${index}`, createSessionListRenderableSessionFixture({
            id: `s${index}`, active: true, activeAt: NOW, metadata: { path: '/repo', host: 'mbp', homeDir: '/u', machineId: 'm1' },
        })] as const));
        const members = [
            ...Array.from({ length: 20 }, (_, index) => member({ kind: 'session', qualifiedId: { serverId: 'home-a', id: `s${index}` } })),
            ...Array.from({ length: 10 }, (_, index) => member({ kind: 'workflow_run', qualifiedId: { serverId: 'home-a', id: `r${index}` } })),
            ...Array.from({ length: 10 }, (_, index) => member({ kind: 'machine', qualifiedId: { serverId: 'home-a', id: `m${index}` } })),
        ];
        const facts = (sessionRows: ReadonlyMap<string, ReturnType<typeof createSessionListRenderableSessionFixture>>): BoardCardFacts => ({
            nowMs: NOW,
            session: (ref) => sessionRows.get(ref.qualifiedId.id) ?? null,
            workflowRun: (ref) => workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: ref.qualifiedId.id, state: 'running' }), null),
            machine: (ref) => createMachineFixture({ id: ref.qualifiedId.id, active: true, activeAt: NOW }),
            machineScope: serverId => ({ serverId, accountId: 'owner' }),
            machineSessionCounts: new Map(),
            workflow: () => null,
            accountScopedHome: () => true,
        });
        const before = buildBoardCards(members, facts(rows));
        expect(before).toHaveLength(40);
        const updated = new Map(rows);
        updated.set('s7', { ...rows.get('s7')!, hasPendingPermissionRequests: true, pendingRequestObservedAt: NOW });
        const after = reconcileBoardCards(before, buildBoardCards(members, facts(updated)));

        const changed = after.filter((card, index) => card !== before[index]);
        expect(changed.map((card) => card.ref.qualifiedId.id)).toEqual(['s7']);
        expect(changed[0]!.status.bucket).toBe('needs_you');
        // Nothing changed at all: the previous list itself is kept.
        expect(reconcileBoardCards(after, buildBoardCards(members, facts(updated)))).toBe(after);
    });

    it('says in the column what a board holds right now: who needs you, then how many items (lab boards-B1)', () => {
        const status = (bucket: 'needs_you' | 'working') => ({ bucket, tone: bucket === 'needs_you' ? 'attention' as const : 'neutral' as const, word: bucket });
        const cards = [status('needs_you'), status('needs_you'), status('working')].map((value, index) => ({
            key: `k${index}`,
            ref: { kind: 'session' as const, qualifiedId: { serverId: 'home-a', id: `s${index}` } },
            picked: true,
            availability: 'ready' as const,
            title: `s${index}`,
            status: value,
            body: { kind: 'none' as const },
        }));
        expect(describeBoardColumnLine(cards)).toEqual({ needYou: 2, text: 'boards.meta.needYou:2 · boards.meta.items:3' });
        expect(describeBoardColumnLine(cards.slice(2))).toEqual({ needYou: 0, text: 'boards.meta.items:1' });
    });
});
