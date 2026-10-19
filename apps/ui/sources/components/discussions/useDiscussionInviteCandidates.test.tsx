import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import { renderHook, standardCleanup, createDeferred, createMachineFixture } from '@/dev/testkit';
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
        const option = hook.getCurrent().flatMap(section => section.kind === 'static' ? section.options : [])
            .find(option => option.id === 'model:offline-target');
        expect(option).toMatchObject({ readiness: { status: 'offline', machineId: 'offline-target' }, repair: null });
        // Listed and selectable, with its one cause instead of the usual hint; never hidden.
        expect(option?.subtitle).toBe(t('session.collaboration.readiness.cause.machineOffline'));
        expect(option?.disabled).toBe(false);
        const configured = hook.getCurrent().flatMap(section => section.options).find(option => option.label === selected.label)!;
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
        await vi.waitFor(() => expect(hook.getCurrent().flatMap(section => section.kind === 'static' ? section.options : [])
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
        const option = hook.getCurrent().flatMap(section => section.kind === 'static' ? section.options : [])
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
        const unnamedOption = hook.getCurrent().flatMap(section => section.kind === 'static' ? section.options : [])
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
});
