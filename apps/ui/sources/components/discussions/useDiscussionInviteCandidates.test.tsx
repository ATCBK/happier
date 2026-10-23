import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import { renderHook, standardCleanup, createDeferred, createMachineFixture, createSessionAccessFixture } from '@/dev/testkit';
import { createSessionListQuerySourceHarness, type SessionListQuerySourceHarness } from '@/dev/testkit/harness/sessionListQuerySourceHarness';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { teamMembershipFixture, teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { useDiscussionInviteCandidates } from './useDiscussionInviteCandidates';
import type { DiscussionInviteCandidate } from './discussionInviteCandidates';
import { useExecutableParticipantSections } from './useExecutableParticipantSections';
import { buildExecutableParticipantPickerOption } from '@/components/sessions/authoring/executableParticipantPicker';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { storage } from '@/sync/domains/state/storageStore';
import { getSessionName, getSessionWorkContext } from '@/utils/sessions/sessionUtils';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { t } from '@/text';
import { parseDecryptedSessionMetadata } from '@/sync/engine/sessions/parsePlainSessionPayload';
import { readableSessionDisplayTitle, sessionDisplayTitle } from '@/utils/sessions/sessionDisplayTitle';
import { selectSessionDisplayNameSource } from '@/sync/domains/state/storage';
import { captureMachinePresenceObservation, clearMachineRequestReachabilityForTest, recordMachineRequestFailed, withdrawMachinePresenceForScope } from '@/sync/domains/machines/reachability/machineReachability';

vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

let boundary: SessionListQuerySourceHarness;
beforeEach(async () => { boundary = await createSessionListQuerySourceHarness(); });
afterEach(async () => { standardCleanup(); await boundary.dispose(); });
const user = (id: string) => ({ id, firstName: id, lastName: null, avatar: null, username: id, bio: null, status: 'none', publicKey: null });
async function captureHome(serverId: string) {
    const hook = await renderHook(() => useServerCredentialAccountScopeBindings([serverId]));
    await vi.waitFor(() => expect(hook.getCurrent().get(serverId)?.isCurrent()).toBe(true));
    return hook.getCurrent().get(serverId)!;
}

describe('Discussion Invite source composition', () => {
    it('omits retired model targets and puts scoped available Machines before retained unavailable setup choices', async () => {
        const home = boundary.serverIds[1]!;
        const accountLifetime = await captureHome(home);
        boundary.http.answer(home, '/v1/teams/list', { body: { items: [], nextCursor: null } });
        const machine = (id: string, overrides: Parameters<typeof createMachineFixture>[0] = {}) => createMachineFixture({
            id, activeAt: Date.now(), metadata: { ...createMachineFixture().metadata!, displayName: id }, ...overrides,
        });
        const inventory = [
            machine('a-offline', { active: false, activeAt: 0 }),
            machine('b-unknown'),
            machine('c-failed'),
            machine('removed', { revokedAt: 1 }),
            machine('replaced', { replacedByMachineId: 'z-ready' }),
            machine('ephemeral', { kind: 'ephemeral_session_runner' }),
            machine('z-ready'),
            machine('y-ready', { revokedAt: 0, replacedByMachineId: '  ' }),
        ];
        withdrawMachinePresenceForScope(accountLifetime.scope);
        captureMachinePresenceObservation(accountLifetime.scope)(inventory.filter(row => row.id !== 'b-unknown').map(row => row.id));
        recordMachineRequestFailed({ ...accountLifetime.scope, machineId: 'c-failed' });
        try {
            storage.setState({ machineListByServerId: { [home]: inventory } });
            const hook = await renderHook(() => useExecutableParticipantSections({ accountLifetime, enabled: true,
                sessionsContext: 'Reviewer', onChoose: vi.fn() }));
            const options = () => hook.getCurrent().sections.find(section => section.id === 'agents-models')?.options ?? [];
            const ids = ['model:y-ready', 'model:z-ready', 'model:a-offline', 'model:b-unknown', 'model:c-failed'];
            expect(options().map(option => option.id)).toEqual(ids);
            expect(options().map(option => option.readiness && 'status' in option.readiness ? option.readiness.status : null))
                .toEqual(['ready', 'ready', 'offline', 'unknown', 'offline']);
            expect(options().every(option => !option.disabled)).toBe(true);
            await act(async () => { storage.setState({ machineListByServerId: { [home]: [...inventory].reverse() } }); });
            expect(options().map(option => option.id)).toEqual(ids);
        } finally {
            clearMachineRequestReachabilityForTest();
        }
    });

    it('projects encrypted title readability from the exact Home title owner and tracks unlock without label heuristics', async () => {
        const [focusedHome, home] = boundary.serverIds as [string, string, string];
        const accountLifetime = await captureHome(home);
        boundary.setRows(home, ['same-id', 'readable']);
        boundary.http.answer(home, '/v1/teams/list', { body: { items: [], nextCursor: null } });
        const hook = await renderHook(() => useDiscussionInviteCandidates({ accountLifetime, availability: 'available', enabled: true }));
        await vi.waitFor(() => expect(hook.getCurrent().candidates.filter(candidate => candidate.kind === 'session')).toHaveLength(2));
        const readable = createSessionFixture({ id: 'readable', serverId: home, encryptionMode: 'e2ee', metadataLayoutVersion: 1,
            encryptedContentAvailability: 'ready', metadata: parseDecryptedSessionMetadata({ v: 1 }, 1),
            ownerMetadataView: { name: 'Cached private review', host: 'review-box', path: '/release' } });
        const locked = { ...readable, id: 'same-id', encryptedContentAvailability: 'encrypted_access_pending' as const,
            // A recipient remains visible but has no Account-owned title view to open.
            // An owner with an unavailable envelope is deliberately not a list candidate:
            // its private hidden-system classification cannot be established.
            access: createSessionAccessFixture('edit'), accessLevel: 'edit' as const,
            metadata: null, ownerMetadataView: null };
        await act(async () => { storage.setState(state => ({
            sessions: { ...state.sessions, 'same-id': createSessionFixture({ id: 'same-id', serverId: focusedHome,
                encryptionMode: 'plain', metadata: { name: 'Readable other Home', host: 'other', path: '/other' } }) },
            sessionListRowsByServerId: { ...state.sessionListRowsByServerId, [home]: {
                ...state.sessionListRowsByServerId[home], 'same-id': buildSessionListRenderableFromSession(locked),
                readable: buildSessionListRenderableFromSession(readable),
            } },
        })); });
        const candidates = hook.getCurrent().candidates;
        const lockedCandidate = candidates.find(candidate => candidate.kind === 'session' && candidate.selection.session.sessionId === 'same-id');
        const readableCandidate = candidates.find(candidate => candidate.kind === 'session' && candidate.selection.session.sessionId === 'readable');
        const lockedSource = selectSessionDisplayNameSource(storage.getState(), 'same-id', home);
        const readableSource = selectSessionDisplayNameSource(storage.getState(), 'readable', home);
        expect(readableCandidate).toMatchObject({ label: sessionDisplayTitle(readableSource), titleReadable: true });
        expect(readableCandidate?.kind === 'session' && readableCandidate.label).toBe('Cached private review');
        expect(readableSessionDisplayTitle(lockedSource)).toBeNull();
        expect(lockedCandidate).toMatchObject({ label: sessionDisplayTitle(lockedSource), titleReadable: false });
        const lockedLabel = sessionDisplayTitle(lockedSource)!;
        await act(async () => { storage.setState(state => ({ sessions: { ...state.sessions,
            'same-id': { ...state.sessions['same-id']!, metadata: { name: 'Changed other Home', host: 'other', path: '/other' } },
        } })); });
        expect(hook.getCurrent().candidates).toBe(candidates);
        await act(async () => { storage.setState(state => ({ sessionListRowsByServerId: {
            ...state.sessionListRowsByServerId, [home]: { ...state.sessionListRowsByServerId[home],
                'same-id': buildSessionListRenderableFromSession({ ...locked, encryptedContentAvailability: 'ready',
                    metadata: parseDecryptedSessionMetadata({ v: 1, summary: { text: lockedLabel, updatedAt: 1 } }, 1) }),
            },
        } })); });
        // A readable title may deliberately have the same words as the locked label.
        expect(hook.getCurrent().candidates.find(candidate => candidate.kind === 'session' && candidate.selection.session.sessionId === 'same-id'))
            .toMatchObject({ key: lockedCandidate?.key, label: lockedLabel, titleReadable: true });
    });

    it('keeps an offline model target in the demanded picker with its readiness and repair data', async () => {
        const home = boundary.serverIds[1]!;
        const accountLifetime = await captureHome(home);
        storage.setState({ machineListByServerId: { [home]: [createMachineFixture({ id: 'offline-target', active: false, activeAt: 0 })] } });
        boundary.http.answer(home, '/v1/teams/list', { body: { items: [], nextCursor: null } });
        const selected = buildExecutableParticipantPickerOption({ label: 'Configured model',
            selection: { kind: 'model', launch: { executionTarget: { serverId: home, machineId: 'offline-target' },
                directory: { kind: 'path', path: '/work' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } } },
            readiness: { configured: true, machine: { selectedMachineId: 'offline-target', machine: null },
                agent: null, selection: null, inventory: { status: 'idle', lastCheckedAt: null },
                invocation: null, mayRepairAgent: false } });
        if (!selected) throw new Error('Invalid selected model fixture');
        const choose = vi.fn();
        const hook = await renderHook(() => useExecutableParticipantSections({ accountLifetime, enabled: true,
            modelOptions: [selected], sessionsContext: 'Answers with its own setup', onChoose: choose }));
        const option = hook.getCurrent().sections.flatMap(section => section.kind === 'static' ? section.options : [])
            .find(option => option.id === 'model:offline-target');
        expect(option).toMatchObject({ readiness: { status: 'offline', machineId: 'offline-target' }, repair: null });
        // Listed and selectable, with its one cause instead of the usual hint; never hidden.
        expect(option?.subtitle).toBe(t('session.collaboration.readiness.cause.machineOffline'));
        expect(option?.disabled).toBe(false);
        const configured = hook.getCurrent().sections.flatMap(section => section.options).find(option => option.label === selected.label)!;
        expect(configured.readiness).toBe(selected.readiness);
        expect(configured.repair).toBe(selected.repair);
        configured.onSelect?.();
        expect(choose).toHaveBeenCalledWith(selected.value);
    });
    it('carries the sidebar title and work context through the captured-Home participant presenter', async () => {
        const home = boundary.serverIds[1]!;
        const accountLifetime = await captureHome(home);
        boundary.setRows(home, ['same-id']);
        boundary.http.answer(home, '/v1/teams/list', { body: { items: [], nextCursor: null } });
        const choose = vi.fn();
        const hook = await renderHook(() => useExecutableParticipantSections({ accountLifetime, enabled: true,
            sessionsContext: 'Answers with its own setup', onChoose: choose }));
        await vi.waitFor(() => expect(hook.getCurrent().sections.flatMap(section => section.kind === 'static' ? section.options : [])
            .some(option => option.id === 'session:same-id')).toBe(true));
        const session = createSessionFixture({ id: 'same-id', serverId: home, encryptionMode: 'e2ee', metadataLayoutVersion: 1,
            metadata: parseDecryptedSessionMetadata({ v: 1, agentPresentation: { agentId: 'codex' } }, 1),
            ownerMetadataView: { name: 'Release review', host: 'review-box', path: '/release' } });
        const row = buildSessionListRenderableFromSession(session);
        await act(async () => { storage.setState(state => ({
            sessions: { ...state.sessions, 'same-id': createSessionFixture({ id: 'same-id', serverId: boundary.serverIds[0],
                metadata: { name: 'Wrong Home', host: 'other', path: '/wrong' } }) },
            sessionListRowsByServerId: { ...state.sessionListRowsByServerId,
                [home]: { ...state.sessionListRowsByServerId[home], 'same-id': row } },
        })); });
        const option = hook.getCurrent().sections.flatMap(section => section.kind === 'static' ? section.options : [])
            .find(option => option.id === 'session:same-id')!;
        expect(option.label).toBe(getSessionName(row, home));
        expect(option.label).toBe('Release review');
        expect(option.subtitle).toContain('Codex');
        expect(option.subtitle).toContain('review-box');
        // How a session takes part is said once, beside the section title, not repeated on every row.
        expect(option.subtitle).not.toContain('Answers with its own setup');
        // The row leads with the Agent's own mark, the identity its byline names, not a generic robot.
        expect((option.icon as React.ReactElement<{ agentId?: string }>).props.agentId).toBe('codex');
        option.onSelect?.();
        expect(choose).toHaveBeenCalledWith({ kind: 'session', session: { serverId: home, sessionId: 'same-id' } });
        // When no Agent/Machine identity is recorded, the list's public recency still distinguishes rows.
        const activityAt = Date.parse('2026-10-19T03:42:00.000Z');
        const unnamedRow = buildSessionListRenderableFromSession({ ...session,
            metadata: { path: '', host: '' }, ownerMetadataView: { path: '', host: '' },
            encryptedContentAvailability: 'ready', meaningfulActivityAt: activityAt });
        expect(getSessionWorkContext(unnamedRow, home)).toBeNull();
        await act(async () => { storage.setState(state => ({ sessionListRowsByServerId: {
            ...state.sessionListRowsByServerId, [home]: { ...state.sessionListRowsByServerId[home], 'same-id': unnamedRow },
        } })); });
        const unnamedOption = hook.getCurrent().sections.flatMap(section => section.kind === 'static' ? section.options : [])
            .find(option => option.id === 'session:same-id')!;
        expect(unnamedOption.subtitle).toContain(formatAsOfTime(activityAt));
        expect(unnamedOption.subtitle).not.toContain('review-box');
        expect((unnamedOption.icon as React.ReactElement<{ name?: string }>).props.name).toBe('robot');
    });
    it('uses captured-Home people paging and the real existing Session roster without borrowing the focused Home', async () => {
        const [homeA, homeB] = boundary.serverIds as [string, string, string];
        const accountLifetime = await captureHome(homeB);
        const focusedHome = boundary.focusedHome();
        boundary.setRows(homeA, ['same-id']);
        boundary.setRows(homeB, ['same-id', 'joined']);
        boundary.http.answer(homeB, '/v1/teams/list', { body: { items: [], nextCursor: null } });
        boundary.http.answer(homeB, '/v1/user/search', { select: (_input, request) => {
            const url = new URL(request.url);
            expect(url.searchParams.get('purpose')).toBe('collaboration');
            expect(url.searchParams.get('query')).toBe('person');
            return { body: { users: url.searchParams.has('cursor') ? [user('person-page-two')] : [user('invited'), user('person-page-one')],
                nextCursor: url.searchParams.has('cursor') ? null : 'people-2' } };
        } });
        const roster = DiscussionParticipantsListResponseV1Schema.parse({ discussionId: 'd', ownerAccountId: accountLifetime.scope.accountId,
            access: 'owner', grants: [{ principal: { kind: 'account', accountId: 'invited' }, accessLevel: 'edit',
                createdByAccountId: accountLifetime.scope.accountId, createdAt: 1, display: { name: null } }],
            participants: [{ participant: { kind: 'session', sessionId: 'joined' }, answerPolicy: 'when_addressed', createdAt: 1 }],
        });
        const hook = await renderHook(({ enabled }: { enabled: boolean }) => useDiscussionInviteCandidates({ accountLifetime, availability: 'available', enabled, roster }), {
            initialProps: { enabled: false },
        });
        expect(hook.getCurrent().candidates).toEqual([]);
        expect(boundary.queryRequests).toEqual([]);
        expect(await hook.getCurrent().people.resolve('person', new AbortController().signal)).toEqual([]);
        await hook.rerender({ enabled: true });
        await vi.waitFor(() => expect(hook.getCurrent().sessions.state?.phase).toBe('ready'));
        expect(hook.getCurrent().candidates.filter(candidate => candidate.kind === 'session').map(candidate => candidate.selection.session))
            .toEqual([{ serverId: homeB, sessionId: 'same-id' }]);
        let people: readonly Extract<DiscussionInviteCandidate, { kind: 'account' }>[] = [];
        await act(async () => { people = await hook.getCurrent().people.resolve('person', new AbortController().signal); });
        expect(people.map(candidate => candidate.participant.accountId)).toEqual(['person-page-one']);
        expect(hook.getCurrent().people.hasMore).toBe(true);
        await act(async () => hook.getCurrent().people.loadMore());
        await vi.waitFor(() => expect(hook.getCurrent().people.hasMore).toBe(false));
        await act(async () => { people = await hook.getCurrent().people.resolve('person', new AbortController().signal); });
        expect(people.map(candidate => candidate.participant.accountId)).toEqual(['person-page-one', 'person-page-two']);
        await act(async () => hook.getCurrent().sessions.loadMore());
        expect(hook.getCurrent().sessions.complete).toBe(true);
        expect(boundary.focusedHome()).toBe(focusedHome);
        expect(boundary.queryRequests.every(request => request.serverId === homeB)).toBe(true);
        const peopleRequests = boundary.http.requests.filter(request => request.path.startsWith('/v1/user/search?'));
        expect(peopleRequests).toHaveLength(2);
        expect(peopleRequests.every(request => request.serverId === homeB)).toBe(true);
    });

    it('projects only active Team members and withdraws a captured Account on retirement', async () => {
        const home = boundary.serverIds[1]!;
        const accountLifetime = await captureHome(home);
        boundary.http.answer(home, '/v1/teams/members/list', { body: { items: [
            teamMembershipFixture({ accountId: 'team-person' }),
            teamMembershipFixture({ id: 'suspended', accountId: 'suspended', status: 'suspended' }),
        ], nextCursor: null } });
        boundary.http.answer(home, '/v1/teams/list', { body: { items: [teamSummaryFixture()], nextCursor: null } });
        const hook = await renderHook(() => useDiscussionInviteCandidates({ accountLifetime, availability: 'available', enabled: true,
            teamAddress: { serverId: home, teamId: 'team-1' } }));
        await vi.waitFor(() => expect(hook.getCurrent().candidates.filter(candidate => candidate.kind === 'account').map(candidate => candidate.participant.accountId))
            .toEqual(['team-person']));
        await act(async () => boundary.switchAccount(home, 'replacement'));
        expect(accountLifetime.isCurrent()).toBe(false);
        expect(hook.getCurrent().candidates).toEqual([]);
        expect(await hook.getCurrent().people.resolve('', new AbortController().signal)).toEqual([]);
    });

    it('cancels a captured Account lookup instead of exposing a late old-Account result', async () => {
        const home = boundary.serverIds[1]!;
        const accountLifetime = await captureHome(home);
        const gate = createDeferred<void>();
        boundary.http.answer(home, '/v1/teams/list', { body: { items: [], nextCursor: null } });
        const hook = await renderHook(() => useDiscussionInviteCandidates({ accountLifetime, availability: 'available', enabled: true }));
        boundary.http.answer(home, '/v1/user/search', { status: 503, body: {} });
        await act(async () => {
            await expect(hook.getCurrent().people.resolve('offline', new AbortController().signal)).rejects.toThrow();
        });
        boundary.http.answer(home, '/v1/user/search', { body: { users: [user('late-person')], nextCursor: null }, respondAfter: gate.promise });
        let pending!: Promise<unknown>;
        await act(async () => { pending = hook.getCurrent().people.resolve('late', new AbortController().signal).catch(error => error); });
        await vi.waitFor(() => expect(boundary.http.requests.filter(request => request.path.startsWith('/v1/user/search?'))).toHaveLength(2));
        await act(async () => boundary.switchAccount(home, 'replacement'));
        gate.resolve();
        expect(await pending).toEqual([]);
        expect(hook.getCurrent().candidates).toEqual([]);
    });

    describe('the Session choices say what the listing is doing', () => {
        const sessionOptions = (sections: ReturnType<typeof useExecutableParticipantSections>['sections']) =>
            sections.find(section => section.id === 'agents-sessions')?.options ?? [];
        const find = (sections: ReturnType<typeof useExecutableParticipantSections>['sections'], testID: string) =>
            sessionOptions(sections).find(option => option.testID === testID);
        const mountPicker = async (home: string) => {
            const accountLifetime = await captureHome(home);
            boundary.http.answer(home, '/v1/teams/list', { body: { items: [], nextCursor: null } });
            const hook = await renderHook(() => useExecutableParticipantSections({ accountLifetime, enabled: true,
                sessionsContext: 'Reviewer', onChoose: vi.fn() }));
            return { accountLifetime, hook };
        };

        it('says it is looking while the first page loads, then offers Retry for a failed first page and recovers the choices', async () => {
            const home = boundary.serverIds[1]!;
            boundary.setRows(home, ['recovered']);
            boundary.failQueries(home, 'all');
            boundary.holdQueries(home);
            const { hook } = await mountPicker(home);
            await vi.waitFor(() => expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-loading')).toBeDefined());
            const loading = find(hook.getCurrent().sections, 'discussion-invite-sessions-loading')!;
            expect(loading.label).toBe(t('workflows.conversation.sessionsLoading'));
            expect(loading.disabled).toBe(true);
            expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-more')).toBeUndefined();
            await act(async () => boundary.releaseQueries(home));
            await vi.waitFor(() => expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-retry')).toBeDefined());
            // No continuation exists after a failed first page: it is not presented as pagination.
            expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-more')).toBeUndefined();
            expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-loading')).toBeUndefined();
            const retry = find(hook.getCurrent().sections, 'discussion-invite-sessions-retry')!;
            expect(retry.label).toBe(t('workflows.conversation.sessionsFailed'));
            expect(retry.subtitle).toBe(t('workflows.conversation.retryLoadingSessions'));
            expect(retry.disabled).toBeFalsy();
            boundary.failQueries(home, null);
            const before = boundary.queryRequests.length;
            await act(async () => retry.onSelect?.());
            await vi.waitFor(() => expect(sessionOptions(hook.getCurrent().sections).map(option => option.id)).toContain('session:recovered'));
            expect(boundary.queryRequests.slice(before).every(request => request.cursor === null)).toBe(true);
            expect(boundary.queryRequests.length).toBeGreaterThan(before);
            expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-retry')).toBeUndefined();
        });

        it('offers More sessions only while a continuation exists, and a page loads on choosing it', async () => {
            const home = boundary.serverIds[1]!;
            boundary.setRows(home, ['first']);
            const { hook } = await mountPicker(home);
            await vi.waitFor(() => expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-more')).toBeDefined());
            expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-retry')).toBeUndefined();
            expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-loading')).toBeUndefined();
            await act(async () => find(hook.getCurrent().sections, 'discussion-invite-sessions-more')!.onSelect?.());
            await vi.waitFor(() => expect(sessionOptions(hook.getCurrent().sections).map(option => option.id)).toContain(`session:${boundary.accountId(home)}-page-2`));
            expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-more')).toBeUndefined();
            expect(boundary.queryRequests.some(request => request.cursor === `cursor:${boundary.accountId(home)}`)).toBe(true);
        });

        it('keeps the loaded Sessions when a next page fails and retries that page', async () => {
            const home = boundary.serverIds[1]!;
            boundary.setRows(home, ['first']);
            const { hook } = await mountPicker(home);
            await vi.waitFor(() => expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-more')).toBeDefined());
            boundary.failQueries(home, 'nextPage');
            await act(async () => find(hook.getCurrent().sections, 'discussion-invite-sessions-more')!.onSelect?.());
            await vi.waitFor(() => expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-retry')).toBeDefined());
            const retry = find(hook.getCurrent().sections, 'discussion-invite-sessions-retry')!;
            expect(retry.label).toBe(t('session.collaboration.discussion.participants.moreSessionsFailed'));
            expect(sessionOptions(hook.getCurrent().sections).map(option => option.id)).toContain('session:first');
            expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-more')).toBeUndefined();
            boundary.failQueries(home, null);
            await act(async () => retry.onSelect?.());
            await vi.waitFor(() => expect(sessionOptions(hook.getCurrent().sections).map(option => option.id)).toContain(`session:${boundary.accountId(home)}-page-2`));
            expect(sessionOptions(hook.getCurrent().sections).map(option => option.id)).toContain('session:first');
            // The retry asked for the failed page, not a fresh first page.
            expect(boundary.queryRequests.at(-1)?.cursor).toBe(`cursor:${boundary.accountId(home)}`);
            expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-retry')).toBeUndefined();
        });

        it('presents nothing and reads nothing once the picker closes or its Account retires', async () => {
            const home = boundary.serverIds[1]!;
            boundary.setRows(home, ['first']);
            boundary.failQueries(home, 'all');
            const { accountLifetime, hook } = await mountPicker(home);
            await vi.waitFor(() => expect(find(hook.getCurrent().sections, 'discussion-invite-sessions-retry')).toBeDefined());
            const retry = find(hook.getCurrent().sections, 'discussion-invite-sessions-retry')!;
            await act(async () => boundary.switchAccount(home, 'replacement'));
            expect(accountLifetime.isCurrent()).toBe(false);
            expect(sessionOptions(hook.getCurrent().sections)).toEqual([]);
            boundary.failQueries(home, null);
            const before = boundary.queryRequests.length;
            await act(async () => retry.onSelect?.());
            expect(boundary.queryRequests).toHaveLength(before);
        });
    });
});
