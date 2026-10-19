import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { SessionLookupByTagsRequestV2Schema, SessionLookupByTagsResponseV2Schema, V2SessionByIdResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { buildSessionSpawnInitialInputLocalIdV1 } from '@happier-dev/protocol/sessions/messages/spawnedFirstTurn';
import { SessionMessageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { readSpawnAttemptCustodyState } from '@/sync/domains/session/spawn/spawnAttemptNonceStore';

const http = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(http);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { captureLazyActionAccountContext } = await import('./actionAccountContext');
const { buildManualSessionCreationKey, executeManualSessionSpawnNewAction } = await import('./sessionSpawnNewAction');
const { disconnectActiveServerConnection, switchConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
const { setRuntimeFetch, resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');

let serverId: string;
let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | undefined;
const userAttemptId = 'attempt-with-lost-ack';
const creationKey = buildManualSessionCreationKey(userAttemptId);
const tag = deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey });
const firstTurnLocalId = buildSessionSpawnInitialInputLocalIdV1({ sessionCreationTag: tag });
const failure = { ok: false as const, errorCode: 'action_failed', error: 'Action acknowledgement unavailable' };

async function installCreationCandidates(ids: readonly string[], archivedAt: number | null = null, onLookup?: () => void) {
    const sessions = Object.fromEntries(ids.map(id => [id, createSessionFixture({ id, serverId })]));
    const boundary = createSessionMetadataHttpBoundary(() => sessions);
    const rows = await Promise.all(ids.map(async id => {
        const response = boundary.handle(`https://start-reconcile.test/v2/sessions/${id}`);
        if (!response) throw new Error('Canonical Session fixture unavailable');
        const body = V2SessionByIdResponseSchema.parse(await response.json());
        return { ...body.session, archivedAt };
    }));
    http.answer(serverId, '/v2/sessions/lookup-by-tags', { select: input => {
        expect(SessionLookupByTagsRequestV2Schema.parse(input)).toEqual({ tags: [tag] });
        onLookup?.();
        return { body: SessionLookupByTagsResponseV2Schema.parse({ sessions: rows }) };
    } });
}

function start(executeAction: NonNullable<Parameters<typeof executeManualSessionSpawnNewAction>[2]['executeAction']>) {
    return executeManualSessionSpawnNewAction({
        creationKey, executionTarget: { serverId, machineId: 'selected-machine' },
        directory: { kind: 'path', path: '/work/project' }, organizationPlacement: { folderId: null, tagIds: [] },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        initialInput: { text: 'Please inspect this project' },
    }, { surface: 'ui', actionRequestId: userAttemptId }, {
        scope: { serverId, accountId: 'original-account' }, machineHomeDir: '/home/tester', userAttemptId,
        seedNonce: 'original-spawn-nonce', sourceAccountLifetime: account!.accountLifetime, executeAction,
    });
}

beforeEach(async () => {
    actionOperationStore.reset();
    getPersistenceStorage().clearAll();
    await http.reset();
    installHomeGovernanceBoundaries(http);
    serverId = await http.addHome({ name: 'Start Home', serverUrl: 'https://start-reconcile.test', accountId: 'original-account', currentAccount: true });
    setRuntimeFetch(http.request);
    http.answer(serverId, '/v1/auth/ping', { body: {} });
    await switchConnectionToActiveServer();
    account = await captureLazyActionAccountContext(serverId);
});
afterEach(async () => {
    actionOperationStore.reset();
    account?.dispose(); account = undefined;
    await disconnectActiveServerConnection();
    resetRuntimeFetch();
    await http.reset();
    getPersistenceStorage().clearAll();
});

describe('manual Start acknowledgement reconciliation', () => {
    it('rejoins an accepted operation from submitted custody without reading Session existence or spawning again', async () => {
        const accepted = { ok: true as const, result: {
            type: 'pending' as const, retryWithSameCreationKey: true as const, outcome: 'accepted' as const,
        } };
        const execute = vi.fn(async () => accepted);
        await start(execute);
        actionOperationStore.mergeSnapshots({ serverId, snapshots: [{ version: 1,
            operationId: 'running-start', revision: 1, actionId: 'session.spawn_new', state: 'running',
            requestId: creationKey, scope: { accountId: 'original-account', machineId: 'selected-machine' },
            title: 'Create session', createdAt: 1, startedAt: 2, cancellation: 'supported',
        }] });
        await installCreationCandidates(['created-session']);
        expect(await start(execute)).toMatchObject({ status: 'executed', action: accepted });
        expect(execute).toHaveBeenCalledTimes(1);
        expect(http.requestsFor('/v2/sessions/lookup-by-tags')).toHaveLength(0);
    });

    it('keeps an accepted start pending while its Session exists but first-input admission is still running', async () => {
        await installCreationCandidates(['created-session']);
        http.answer(serverId, `/v2/sessions/created-session/messages/by-local-id/${encodeURIComponent(firstTurnLocalId)}`, { status: 404, body: {} });
        const accepted = { ok: true as const, result: {
            type: 'pending' as const, retryWithSameCreationKey: true as const, outcome: 'accepted' as const,
        } };

        const settled = await start(async () => accepted);

        expect(settled).toMatchObject({ status: 'executed', action: accepted });
        // The live start owner still holds admission. A committed Session row
        // alone cannot turn that pending work into a first-input warning.
        expect(http.requestsFor('/v2/sessions/lookup-by-tags')).toHaveLength(0);
    });

    it('continues the exact durably-created Session and admitted first input after action_failed, without another spawn', async () => {
        await installCreationCandidates(['created-session']);
        const message = SessionMessageV1Schema.parse({ id: 'first-message', seq: 1, localId: firstTurnLocalId,
            messageRole: 'user', content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Please inspect this project' } } },
            createdAt: 1, updatedAt: 1 });
        http.answer(serverId, `/v2/sessions/created-session/messages/by-local-id/${encodeURIComponent(firstTurnLocalId)}`, { body: { message } });
        // The presentation host's execution boundary loses its acknowledgement;
        // Account capture, HTTP reads, schemas and durable custody stay real.
        const executeAction = vi.fn(async () => failure);
        const settled = await start(executeAction);
        expect(settled).toMatchObject({ status: 'executed', custody: { createdSessionId: 'created-session' },
            action: { ok: true, result: { type: 'success', disposition: 'rejoined', sessionId: 'created-session',
                initialInput: { status: 'alreadyAccepted', localId: firstTurnLocalId } } } });
        if (settled.status !== 'executed' || !settled.action.ok) throw new Error('Expected reconciled creation');
        expect(SessionSpawnNewResultV1Schema.parse(settled.action.result)).toEqual(settled.action.result);
        expect(await start(executeAction)).toMatchObject({ status: 'executed',
            action: { ok: true, result: { sessionId: 'created-session' } } });
        expect(executeAction).toHaveBeenCalledTimes(1);
        const persisted = readSpawnAttemptCustodyState({ serverId, accountId: 'original-account' });
        expect(persisted.status === 'valid' ? Object.values(persisted.attempts)[0]?.createdSessionId : null).toBe('created-session');
    });

    it('preserves created-session custody without claiming that a missing first-input receipt was accepted', async () => {
        await installCreationCandidates(['created-session']);
        http.answer(serverId, `/v2/sessions/created-session/messages/by-local-id/${encodeURIComponent(firstTurnLocalId)}`, { status: 404, body: {} });
        expect(await start(async () => failure)).toMatchObject({ status: 'executed', custody: { createdSessionId: 'created-session' },
            action: { ok: true, result: { sessionId: 'created-session', initialInput: { status: 'outcomeUnknown', localId: firstTurnLocalId } } } });
    });

    it.each(['missing', 'archived', 'ambiguous'] as const)('keeps the original failure when lookup is %s', async kind => {
        await installCreationCandidates(kind === 'missing' ? [] : kind === 'ambiguous' ? ['first', 'second'] : ['archived'], kind === 'archived' ? 2 : null);
        expect(await start(async () => failure)).toMatchObject({ status: 'executed', action: failure, custody: { createdSessionId: null } });
    });

    it('never reconciles a definitive authorization refusal into success', async () => {
        await installCreationCandidates(['created-session']);
        const denied = { ok: false as const, errorCode: 'permission_denied', error: 'Not permitted' };
        expect(await start(async () => denied)).toMatchObject({ status: 'executed', action: denied });
        expect(http.requestsFor('/v2/sessions/lookup-by-tags')).toHaveLength(0);
    });

    it('does not read or disclose a reconciliation after the originating Account lifetime retires', async () => {
        await installCreationCandidates(['created-session']);
        account!.dispose();
        const cancellation = new AbortController();
        account = await captureLazyActionAccountContext(serverId, cancellation.signal);
        expect(await start(async () => { cancellation.abort(); return failure; })).toMatchObject({ status: 'executed', action: failure });
        expect(http.requestsFor('/v2/sessions/lookup-by-tags')).toHaveLength(0);
    });

    it('rechecks originating Account admission after the submitted-attempt lookup before issuing another Action', async () => {
        account!.dispose();
        const cancellation = new AbortController();
        account = await captureLazyActionAccountContext(serverId, cancellation.signal);
        await installCreationCandidates([]);
        const executeAction = vi.fn(async () => failure);
        expect(await start(executeAction)).toMatchObject({ status: 'executed', action: failure });
        await installCreationCandidates(['created-session'], null, () => cancellation.abort());
        expect(await start(executeAction)).toMatchObject({ status: 'executed',
            action: { ok: false, errorCode: 'action_account_scope_changed' } });
        expect(executeAction).toHaveBeenCalledTimes(1);
    });
});
