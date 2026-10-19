import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createExistingSessionDirectoryPreflightResult } from '@/dev/testkit/fixtures/sessionFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { DiscussionInviteRequestV1Schema, DiscussionParticipantPolicySetRequestV1Schema, DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import { DiscussionMessageV1Schema, DiscussionSummaryV1Schema } from '@happier-dev/protocol/discussions/models';
import { DiscussionModelParticipantLaunchV1Schema, projectDiscussionModelParticipantLaunchV1 } from '@happier-dev/protocol/discussions/modelParticipantLaunch';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { MachineAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { ProfileRecordV1Schema, ProfileRowsListResponseV1Schema, PROFILE_ROWS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1, ProfileTransferRowReadResponseV1Schema } from '@happier-dev/protocol/profiles/profileTransferV1';
import { SessionSpawnNewResultV1Schema, type SessionSpawnNewResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';

// The person accepts the real Action policy's UI confirmation at the presentation boundary.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
let spawnServerId = '';
let spawnResultOverride: SessionSpawnNewResultV1 | null = null;
const spawnRequests: SocketRpcRequestPayload[] = [];
const spawnParseIssues: unknown[] = [];
// Daemon acknowledgements are a network boundary; admission uses its actual
// strict RPC binding, also exercised by the CLI registered-handler suite.
installDisconnectedServerSocketBoundary(socket => {
    vi.mocked(socket.connect).mockImplementation(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
    vi.spyOn(socket, 'timeout').mockReturnValue(socket);
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event: string, request: SocketRpcRequestPayload) => {
        if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
        if (request.method === `machine-a:${RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT}`) {
            return { ok: true, result: createExistingSessionDirectoryPreflightResult(request.params) };
        }
        if (request.method !== `machine-a:${RPC_METHODS.SESSION_SPAWN_NEW}`) throw new Error(`Unexpected daemon request: ${request.method}`);
        spawnRequests.push(request);
        const inputSchema = getActionSpec('session.spawn_new').surfaceBindings?.rpc?.inputSchema;
        if (!inputSchema) throw new Error('Missing canonical Session spawn RPC binding');
        const parsed = inputSchema.safeParse(request.params);
        if (!parsed.success) {
            spawnParseIssues.push(...parsed.error.issues);
            return { ok: true, result: { ok: false, errorCode: 'invalid_action_transport_input', error: 'invalid_action_transport_input' } };
        }
        return { ok: true, result: spawnResultOverride ?? SessionSpawnNewResultV1Schema.parse({ type: 'success', disposition: 'created', sessionId: 'owned-model-session',
            executionTarget: { serverId: spawnServerId, machineId: 'machine-a' },
            organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } }) };
    });
});
const { getStorage } = await import('@/sync/domains/state/storage');
const { createDiscussionClient } = await import('./discussionActions');
const { createDiscussionRepository } = await import('@/sync/ops/discussions/discussionRepository');
const { buildExecutableModelParticipantSelectionFromAuthoringDraft, buildExecutableParticipantPickerOption } = await import('@/components/sessions/authoring/executableParticipantPicker');
const { buildNewSessionAuthoringDraftFromTempData } = await import('@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters');
const initial = getStorage().getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
beforeEach(async () => { await homes.reset(); spawnRequests.length = 0; spawnParseIssues.length = 0; spawnResultOverride = null; });
afterEach(async () => {
    await connection?.dispose();
    connection = undefined;
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
    serverScopedRpcSocketPool.resetForTests();
    resetScopedMachineTransportCacheForTests();
    getStorage().setState(initial, true);
    standardCleanup();
});

function answerDiscussionRead(serverId: string) {
    const message = DiscussionMessageV1Schema.parse({ id: 'first-message', discussionId: 'discussion-a', localId: 'first-local',
        seq: 1, authorAccountId: 'alice', accountActor: { v: 1, accountId: 'alice', profile: null }, producerV1: null,
        content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Please review.' }] } }, mentionedAccountIds: [], createdAt: 1 });
    const { discussionId: _discussionId, content: _content, mentionedAccountIds: _mentions, ...latestMessage } = message;
    homes.answer(serverId, '/v1/discussions/discussion-a', { body: { discussion: DiscussionSummaryV1Schema.parse({
        id: 'discussion-a', ownerAccountId: 'alice', encryptionMode: 'plain', anchor: null, access: 'owner',
        keyReadiness: true, dataEncryptionKey: null, creationLocalId: 'discussion-create-a',
        titleContent: { t: 'plain', v: { v: 1, title: 'Review' } }, latestMessage,
        messageSeq: 1, lastReadSeq: 1, unreadCount: 0, unreadMentionCount: 0, recentAuthorAccountIds: ['alice'], archivedAt: null,
        capabilities: { postMessages: true, rename: true, archive: true, restore: false,
            askAgent: true, sendToSession: true, manageAccess: true, leave: false },
    }) } });
    homes.answer(serverId, '/v1/discussions/discussion-a/messages', { body: {
        messages: [message], hasMoreOlder: false, messageSeq: 1,
    } });
}

it('keeps model Home admission at the canonical Action before any reservation HTTP request', async () => {
    const serverId = await homes.addHome({ name: 'Review', serverUrl: 'https://review.test', accountId: 'alice', currentAccount: true });
    const launch = { executionTarget: { serverId: 'foreign-home', machineId: 'foreign-machine' },
        directory: { kind: 'path' as const, path: '/workspace' },
        agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
    const client = createDiscussionClient({ scope: { serverId, accountId: 'alice' }, availability: 'available' });
    expect(await client.invite({ discussionId: 'discussion-a', participant: {
        kind: 'model', participantSlotId: 'retained-slot', launch,
    } })).toEqual({ kind: 'failed', errorCode: 'server_target_mismatch' });
    expect(await client.inviteExecutableParticipant({ discussionId: 'discussion-a',
        selection: { kind: 'model', launch }, participantSlotId: 'retained-slot',
    })).toEqual({ kind: 'failed', errorCode: 'server_target_mismatch' });
    expect(homes.requestsFor('/v1/discussions/discussion-a/participants/invite')).toHaveLength(0);
});

it('invites an executable Session choice through the real captured-Home Action and HTTP owner', async () => {
    const serverId = await homes.addHome({ name: 'Review', serverUrl: 'https://review.test', accountId: 'alice', currentAccount: true });
    const path = '/v1/discussions/discussion-a/participants/invite';
    answerDiscussionRead(serverId);
    homes.answer(serverId, `POST ${path}`, { body: {
        discussionId: 'discussion-a', ownerAccountId: 'alice', access: 'owner', grants: [], changed: true,
    } });
    const client = createDiscussionClient({ scope: { serverId, accountId: 'alice' }, availability: 'available' });
    const repository = createDiscussionRepository({ scope: { serverId, accountId: 'alice' }, address: { serverId }, client });
    const outcome = await repository.inviteExecutableParticipant({ discussionId: 'discussion-a',
        selection: { kind: 'bot', session: { serverId, sessionId: 'actual-bot-session' } } });
    expect(outcome).toMatchObject({ kind: 'succeeded', value: { discussionId: 'discussion-a' } });
    const requests = homes.requestsFor(path);
    expect(requests).toHaveLength(1);
    expect(DiscussionInviteRequestV1Schema.parse(requests[0]?.input)).toEqual({
        participant: { kind: 'session', sessionId: 'actual-bot-session' },
    });
    expect(repository.getSnapshot().threads['discussion-a']?.summary).toMatchObject({ id: 'discussion-a', title: 'Review' });
    homes.answer(serverId, `POST ${path}`, { dispatchThenFail: true });
    expect(await repository.inviteExecutableParticipant({ discussionId: 'discussion-a',
        selection: { kind: 'session', session: { serverId, sessionId: 'another-session' } },
    })).toEqual({ kind: 'failed', errorCode: 'outcome_unknown' });
});

it('changes answer policy through the captured-Home client, real Action executor and repository', async () => {
    const serverId = await homes.addHome({ name: 'Review', serverUrl: 'https://review.test', accountId: 'alice', currentAccount: true });
    const path = '/v1/discussions/discussion-a/participants/policy';
    answerDiscussionRead(serverId);
    homes.answer(serverId, `PUT ${path}`, { body: {
        discussionId: 'discussion-a', ownerAccountId: 'alice', access: 'owner', grants: [], changed: true,
    } });
    const client = createDiscussionClient({ scope: { serverId, accountId: 'alice' }, availability: 'available' });
    const repository = createDiscussionRepository({ scope: { serverId, accountId: 'alice' }, address: { serverId }, client });
    expect(await repository.setParticipantPolicy({ discussionId: 'discussion-a',
        participant: { kind: 'session', sessionId: 'agent-session' }, answerPolicy: 'reads_only' }))
        .toMatchObject({ kind: 'succeeded', value: { changed: true } });
    const requests = homes.requestsFor(path);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.serverId).toBe(serverId);
    expect(DiscussionParticipantPolicySetRequestV1Schema.parse(requests[0]?.input)).toEqual({
        participant: { kind: 'session', sessionId: 'agent-session' }, answerPolicy: 'reads_only',
    });
    expect(repository.getSnapshot().threads['discussion-a']?.summary).toMatchObject({ id: 'discussion-a', title: 'Review' });
});

it('reconciles an unknown model reservation with the retained explicit slot before acknowledging a started participant', async () => {
    const serverId = await homes.addHome({ name: 'Review', serverUrl: 'https://review.test', accountId: 'alice', currentAccount: true });
    const path = '/v1/discussions/discussion-a/participants/invite';
    const draft = buildNewSessionAuthoringDraftFromTempData({ prompt: 'Unsent picker draft', directory: '/workspace',
        executionTarget: { kind: 'machine', target: { serverId, machineId: 'unavailable-machine' } },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    });
    const beforePreview = homes.requests.length;
    const selection = buildExecutableModelParticipantSelectionFromAuthoringDraft({ draft, permissionMode: 'read-only', configurationUpdatedAtMs: 123 });
    const option = buildExecutableParticipantPickerOption({ selection, label: 'Review Agent', readiness: {
        configured: true, machine: { scope: { serverId, accountId: 'alice' }, selectedMachineId: 'unavailable-machine',
            machine: null, requireExactSpawnReadiness: true, rpcAvailable: false, keyAvailable: false },
        agent: null, selection: null, inventory: { status: 'ready', lastCheckedAt: 1 }, invocation: null, mayRepairAgent: false,
    } });
    expect(option).toMatchObject({ value: selection, readiness: { status: 'unknown' } });
    expect(homes.requests).toHaveLength(beforePreview);
    const launch = selection.launch;
    answerDiscussionRead(serverId);
    const reservation = {
        discussionId: 'discussion-a', ownerAccountId: 'alice', access: 'owner', grants: [], changed: true,
        modelParticipant: { participant: { kind: 'model', participantSlotId: 'retained-slot' }, launch,
            sessionId: null, answerPolicy: 'when_addressed', createdAt: 1 },
    };
    let loseReserveResponse = true;
    homes.answer(serverId, `POST ${path}`, { select: () => {
        if (loseReserveResponse) { loseReserveResponse = false; return { dispatchThenFail: true }; }
        return { body: reservation };
    } });
    const client = createDiscussionClient({ scope: { serverId, accountId: 'alice' }, availability: 'available' });
    const repository = createDiscussionRepository({ scope: { serverId, accountId: 'alice' }, address: { serverId }, client });
    for (let attempt = 0; attempt < 2; attempt++) {
        const outcome = await repository.inviteExecutableParticipant({ discussionId: 'discussion-a',
            selection: option?.value, participantSlotId: 'retained-slot' });
        expect(outcome).not.toBeNull();
        expect(outcome).not.toMatchObject({ kind: 'succeeded' });
        if (attempt === 0) expect(outcome).toEqual({ kind: 'checking' });
    }
    const requests = homes.requestsFor(path);
    expect(requests).toHaveLength(2);
    expect(requests.map(request => DiscussionInviteRequestV1Schema.parse(request.input)))
        .toEqual(Array.from({ length: 2 }, () => ({ participant: { kind: 'model', participantSlotId: 'retained-slot', launch } })));
});

it.each([{ enriched: false, failure: false, pending: false }, { enriched: true, failure: false, pending: false },
    { enriched: false, failure: true, pending: false }, { enriched: false, failure: false, pending: true }])(
    'sends the selected model launch through strict daemon RPC and participant projection (Profile/Role: $enriched, startup failure: $failure, pending: $pending)', async ({ enriched, failure, pending }) => {
    await loadSyncSingletonForTests();
    const serverUrl = 'https://model-transport.test';
    const serverId = await homes.addHome({ name: 'Model transport', serverUrl, accountId: 'alice', currentAccount: true });
    const token = homes.findByServerUrl(serverUrl)?.token;
    if (!token) throw new Error('Missing fixture Account token');
    connection = await restoreServerAccountForTest({ serverUrl, accountId: 'alice', credentials: { token }, request: homes.request });
    spawnServerId = serverId;
    const row = createPlainMachineRowFixture({ id: 'machine-a', accountId: 'alice' });
    const machine = createMachineFixture({ id: row.id, activeAt: row.activeAt });
    getStorage().setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
    homes.answer(serverId, '/v1/machines', { body: { machines: [row] } });
    homes.answer(serverId, '/v1/machines/machine-a', { body: { machine: row } });
    homes.answer(serverId, '/v1/machines/machine-a/access', { body: MachineAccessGrantsListResponseV1Schema.parse({
        machineId: row.id, custodian: row.access!.custodian, access: row.access,
        canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [],
    }) });
    if (enriched) {
        const record = ProfileRecordV1Schema.parse({ v: 1, id: 'review-profile', enabled: true,
            definition: { kind: 'inline', profile: { v: 2, id: 'review-profile', name: 'Review', createdAt: 1, updatedAt: 1 } },
            promptStack: [], secretBindings: {}, skillSeeds: ['review-seed'] });
        const transferControl = ProfileTransferRowReadResponseV1Schema.parse({ status: 'present', revision: 1, content: { t: 'plain', v: {
            v: 1, phase: 'active', sourceSettingsVersion: 0, migratedLogicalRevision: 0, inventory: [],
        } } });
        homes.answer(serverId, PROFILE_REFERENCE_GUARD_ROUTE_V1, { body: { status: 'ready', revision: 1 } });
        homes.answer(serverId, PROFILE_TRANSFER_ROUTE_V1, { body: transferControl });
        homes.answer(serverId, PROFILE_ROWS_ROUTE_V1, { body: ProfileRowsListResponseV1Schema.parse({
            status: 'listed', rows: [{ id: record.id, revision: 1, content: { t: 'plain', v: record } }],
            nextCursor: null, complete: true, diagnostics: [], referenceGuardRevision: 1,
            transferControl,
        }) });
    }
    const launch = DiscussionModelParticipantLaunchV1Schema.parse({ executionTarget: { serverId, machineId: 'machine-a' },
        directory: { kind: 'path' as const, path: '/workspace' },
        agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        permissionMode: 'read-only' as const, configuration: { mode: { value: null, updatedAtMs: 1 },
            model: { value: 'selected-model', updatedAtMs: 1 }, permissionIntent: { value: 'read-only' as const, updatedAtMs: 1 }, options: {} },
        connectedServices: { v: 2 as const, bindingsByServiceId: { 'happier.agent.codex/openai-codex': {
            source: 'connected' as const, selection: 'profile' as const, profileId: 'selected-login',
        } } },
        ...(enriched ? { profileId: 'review-profile', roleId: 'reviewer' } : {}),
    });
    answerDiscussionRead(serverId);
    homes.answer(serverId, 'POST /v1/discussions/discussion-a/participants/invite', { body: {
        discussionId: 'discussion-a', ownerAccountId: 'alice', access: 'owner', grants: [], changed: true,
        modelParticipant: { participant: { kind: 'model', participantSlotId: 'retained-slot' }, launch,
            sessionId: null, answerPolicy: 'when_addressed', createdAt: 1 },
    } });
    const client = createDiscussionClient({ scope: { serverId, accountId: 'alice' }, availability: 'available' });
    const startFailure = SessionSpawnNewResultV1Schema.parse({ type: 'error', code: 'target_unavailable', retryable: false });
    if (failure) spawnResultOverride = startFailure;
    if (pending) spawnResultOverride = { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' };
    const invitation = { discussionId: 'discussion-a', selection: { kind: 'model' as const, launch }, participantSlotId: 'retained-slot' };
    let outcome: Awaited<ReturnType<typeof client.inviteExecutableParticipant>> | undefined;
    if (failure || pending) {
        const { act, renderHook } = await import('@/dev/testkit/hooks/renderHook');
        const { useDiscussionParticipantManagement } = await import('@/components/discussions/useDiscussionParticipantManagement');
        const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const repository = createDiscussionRepository({ scope: { serverId, accountId: 'alice' }, address: { serverId }, client });
        await repository.refreshDiscussion('discussion-a');
        homes.answer(serverId, '/v1/discussions/discussion-a/participants', { body: DiscussionParticipantsListResponseV1Schema.parse({
            discussionId: 'discussion-a', ownerAccountId: 'alice', access: 'owner', grants: [], participants: [{
                participant: { kind: 'model', participantSlotId: 'retained-slot' }, launch, sessionId: null,
                answerPolicy: 'when_addressed', createdAt: 1,
            }],
        }) });
        const hook = await renderHook(() => {
            const bindings = useServerCredentialAccountScopeBindings([serverId]);
            return useDiscussionParticipantManagement({ accountLifetime: bindings.get(serverId) ?? null,
                discussionId: 'discussion-a', repository, enabled: true, summary: repository.getSnapshot().threads['discussion-a']?.summary ?? null });
        });
        await vi.waitFor(() => expect(hook.getCurrent().roster?.participants).toHaveLength(1));
        expect(hook.getCurrent().modelParticipants).toMatchObject([{ birth: { kind: 'unknown' }, canRetry: true }]);
        await act(async () => { outcome = await hook.getCurrent().inviteExecutable(invitation.selection, { participantSlotId: invitation.participantSlotId }); });
        expect(hook.getCurrent().modelParticipants).toMatchObject([{ birth: failure
            ? { kind: 'failed', errorCode: 'target_unavailable', sessionStart: startFailure }
            : { kind: 'unknown', reason: 'pending' }, canRetry: !failure }]);
        if (failure) {
            await act(async () => { await hook.getCurrent().retry(); });
            expect(spawnRequests).toHaveLength(1);
        }
        await hook.unmount();
    } else outcome = await client.inviteExecutableParticipant(invitation);
    expect(outcome, JSON.stringify({ outcome, spawnParseIssues })).toMatchObject(failure ? {
        kind: 'failed', errorCode: 'target_unavailable', value: { modelParticipant: { participant: { participantSlotId: 'retained-slot' }, sessionId: null },
            sessionStart: startFailure },
    } : pending ? { kind: 'checking', value: { sessionStart: spawnResultOverride } } : { kind: 'succeeded', value: {
        modelParticipant: { sessionId: 'owned-model-session' }, sessionStart: { type: 'success', sessionId: 'owned-model-session' },
    } });
    expect(spawnParseIssues).toEqual([]);
    expect(spawnRequests).toHaveLength(1);
    const outgoing = SessionSpawnNewInputV2Schema.parse(spawnRequests[0]?.params);
    expect(projectDiscussionModelParticipantLaunchV1(outgoing)).toEqual(launch);
    expect(outgoing).toMatchObject({ creationKey: 'retained-slot',
        discussionParticipant: { discussionId: 'discussion-a', participantSlotId: 'retained-slot' }, initialTriggers: [] });
    expect(outgoing).not.toHaveProperty('initialInput');
    if (enriched) expect(homes.requestsFor(PROFILE_ROWS_ROUTE_V1).length).toBeGreaterThan(0);
});
