import { afterEach, expect, it } from 'vitest';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { standardCleanup } from '@/dev/testkit';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { captureUiUsageQueryAccountContext } from '@/sync/api/account/usageQueryResource';
import { projectSessionUsageWorkEvidence } from '@happier-dev/protocol/usage/usageWorkEvidence';
import { SessionReadBatchRequestV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { createOperationAccountCurrentnessSource } from './fetchSessionByIdWithServerScope';
import { runWithServerRequestAuthorityForServerAccountScope } from './createServerRequestWithServerScope';
import { readSessionSnapshotForAuthority, readSessionSnapshotsForAuthority } from './readSessionSnapshotForAuthority';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(async () => { standardCleanup(); retireActiveServerAccountScopeLifetime(); await home?.dispose(); home = undefined; });

it.each(['single', 'batch'] as const)('requires admitted turns only for interval demand through %s reads', async transport => {
    let turnsOutcome: 'failed' | 'invalid' | 'empty' | 'populated' = 'failed';
    const sessionId = 'retry-turns';
    const boundary = createSessionReadBatchHttpBoundary(request => {
        if (request.path === `/v2/sessions/${sessionId}`) return Response.json({ session:
            createPlainSessionCurrentProjectionRecordFixture({ id: sessionId, seq: 1, updatedAt: 900 }) });
        if (request.path === `/v1/sessions/${sessionId}/turns`) {
            if (turnsOutcome === 'failed') return Response.json({ error: 'unavailable' }, { status: 503 });
            return Response.json({ v: 1, sessionId: turnsOutcome === 'invalid' ? 'wrong-session' : sessionId, updatedAt: 900,
                turns: turnsOutcome === 'empty' ? [] : [
                    { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 700, updatedAt: 900 },
                ] });
        }
        return undefined;
    });
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://required-turns.test', accountId: 'account-a' }],
        route: request => boundary.handle(request) });
    publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
    const context = captureUiUsageQueryAccountContext(credentials)!;
    await runWithServerRequestAuthorityForServerAccountScope({ scope: context.accountLifetime.scope, activeRequest: context.request }, async authority => {
        const currentness = createOperationAccountCurrentnessSource({ credentials, request: authority.request, serverId: authority.scope.serverId });
        const read = async (requireTurns: boolean) => {
            if (transport === 'single') return readSessionSnapshotForAuthority({ authority, sessionId, requireTurns, accountCurrentnessSource: currentness });
            const result = (await readSessionSnapshotsForAuthority({ authority, sessionIds: [sessionId], requireTurns, accountCurrentnessSource: currentness })).get(sessionId);
            if (!result?.ok) throw result?.error ?? new Error('Missing batch result');
            return result.snapshot;
        };
        try {
            // Metadata hydration keeps its optional projection even during a turns failure.
            const optional = await read(false);
            expect(optional.session.id).toBe(sessionId);
            expect(optional.session.sessionTurns).toBeUndefined();
            await expect(read(true)).rejects.toMatchObject({ name: 'RetryableServerResponseError', status: 503 });
            turnsOutcome = 'invalid';
            await expect(read(true)).rejects.toMatchObject({ errorCode: 'turns_unavailable' });
            turnsOutcome = 'populated';
            const recovered = await read(true);
            expect(projectSessionUsageWorkEvidence(recovered.session).facts).toMatchObject([
                { evidenceId: 'turn', kind: 'busy', startMs: 100, endMs: 700 },
            ]);
            turnsOutcome = 'empty';
            expect((await read(true)).session.sessionTurns?.turns).toEqual([]);
        } finally { currentness.dispose(); }
    });
});

it.each([false, true])('opens identical single and batch Usage evidence with sharing enabled=%s, quarantining a denied sibling', async sharingEnabled => {
    const ids = ['first', 'second'];
    let duplicateResult = false;
    const detail = (sessionId: string) => ({ session: createPlainSessionCurrentProjectionRecordFixture({ id: sessionId }) });
    const turns = (sessionId: string) => ({ v: 1, sessionId, updatedAt: 900, turns: [
        { turnId: `${sessionId}-turn`, agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 },
    ] });
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://session-batch.test', accountId: 'account-a' }],
        route: request => {
            if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({ features: {
                sharing: { session: { enabled: sharingEnabled } },
            } }));
            if (request.path === '/v2/sessions/read-batch') return Response.json({ results: [
                ...ids.map(sessionId => ({ sessionId: duplicateResult ? 'first' : sessionId,
                    detail: { status: 200, body: detail(sessionId) }, turns: { status: 200, body: turns(sessionId) } })),
                { sessionId: 'denied', detail: { status: 404, body: { error: 'Session not found' } } },
            ] });
            const single = /^\/v2\/sessions\/(first|second)$/.exec(request.path);
            if (single) return Response.json(detail(single[1]!));
            const turn = /^\/v1\/sessions\/(first|second)\/turns$/.exec(request.path);
            if (turn) return Response.json(turns(turn[1]!));
            return undefined;
        } });
    publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
    const context = captureUiUsageQueryAccountContext(credentials)!;
    await getServerFeaturesSnapshot({ serverId: context.accountLifetime.scope.serverId, force: true });
    await runWithServerRequestAuthorityForServerAccountScope({ scope: context.accountLifetime.scope, activeRequest: context.request }, async authority => {
        const currentness = createOperationAccountCurrentnessSource({ credentials, request: authority.request, serverId: authority.scope.serverId });
        try {
            const abort = new AbortController();
            // Match Hermes' supported AbortSignal surface at the platform boundary.
            Object.defineProperty(abort.signal, 'throwIfAborted', { value: undefined });
            const singles = await Promise.all(ids.map(sessionId => readSessionSnapshotForAuthority({ authority, sessionId, accountCurrentnessSource: currentness })));
            const batch = await readSessionSnapshotsForAuthority({ authority, sessionIds: [...ids, 'denied'], accountCurrentnessSource: currentness, signal: abort.signal });
            ids.forEach((id, index) => {
                const result = batch.get(id);
                expect(result).toMatchObject({ ok: true, snapshot: singles[index] });
                if (!result?.ok) throw new Error('Expected admitted batch snapshot');
                expect(projectSessionUsageWorkEvidence(result.snapshot.session)).toEqual(projectSessionUsageWorkEvidence(singles[index]!.session));
            });
            expect(batch.get('denied')).toMatchObject({ ok: false });
            const batchRequests = home!.requests.filter(request => request.path === '/v2/sessions/read-batch');
            expect(batchRequests).toHaveLength(1);
            expect(SessionReadBatchRequestV1Schema.parse(batchRequests[0]!.body).accessProjectionVersion).toBe(sharingEnabled ? 1 : undefined);
            expect(home!.requests.filter(request => /^\/v2\/sessions\/(first|second)$/.test(request.path))
                .every(request => request.url.searchParams.get('accessProjectionVersion') === (sharingEnabled ? '1' : null))).toBe(true);
            await expect(readSessionSnapshotsForAuthority({ authority, sessionIds: ids, accountCurrentnessSource: currentness,
                isCurrent: () => false })).rejects.toMatchObject({ errorCode: 'stale_response' });
            expect(home!.requests.filter(request => request.path === '/v2/sessions/read-batch')).toHaveLength(1);
            duplicateResult = true;
            await expect(readSessionSnapshotsForAuthority({ authority, sessionIds: [...ids, 'denied'], accountCurrentnessSource: currentness }))
                .rejects.toThrow('Invalid Session batch response');
        } finally { currentness.dispose(); }
    });
});
