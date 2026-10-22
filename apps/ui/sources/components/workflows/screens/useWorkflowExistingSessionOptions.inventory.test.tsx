import { afterEach, expect, it } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { storage } from '@/sync/domains/state/storageStore';

let homes: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(async () => {
    standardCleanup();
    await homes?.dispose();
    homes = undefined;
    storage.setState(storage.getInitialState(), true);
});

it('lists paged unopened Sessions without reading hidden/archived snapshots or offering ineligible and other-Home Sessions', async () => {
    const metadata = { flavor: 'claude', claudeSessionId: 'resume-c', claudeTranscriptPath: '/tmp/c.jsonl',
        machineId: 'machine-a', path: '/repo', host: 'host-a', name: 'Session C' };
    const c = createPlainSessionCurrentProjectionRecordFixture({ id: 'unopened-c', active: true, metadata });
    const hidden = createPlainSessionCurrentProjectionRecordFixture({ id: 'hidden', active: true, metadata: {
        ...metadata, systemSessionV1: { v: 1, key: 'voice_transcript_history', hidden: true },
    } });
    const otherMachine = createPlainSessionCurrentProjectionRecordFixture({ id: 'other-machine', active: true,
        metadata: { ...metadata, machineId: 'machine-b' } });
    const archived = Array.from({ length: 300 }, (_, index) => createPlainSessionCurrentProjectionRecordFixture({
        id: `archived-${index}`, active: false, archivedAt: 42, metadata,
    }));
    const ineligible = createPlainSessionCurrentProjectionRecordFixture({ id: 'ineligible', active: true,
        metadata: { flavor: 'claude', machineId: 'machine-a', path: '/repo', host: 'host-a' } });
    let deleted = false;
    const batch = createSessionReadBatchHttpBoundary(request => {
        const record = [c, hidden, otherMachine, ineligible, ...archived].find(row => request.path === `/v2/sessions/${row.id}`);
        return record ? Response.json({ session: record }) : undefined;
    });
    homes = await serveAccountHomes({ homes: [
        { key: 'a', serverUrl: 'https://workflow-picker-a.test', accountId: 'picker-account-a' },
        { key: 'b', serverUrl: 'https://workflow-picker-b.test', accountId: 'picker-account-b' },
    ], route: request => {
        if (request.path === '/v2/sessions/archived') {
            return Response.json({ sessions: archived, nextCursor: null, hasNext: false });
        }
        if (request.path === '/v2/sessions/active') {
            return Response.json({ sessions: [], nextCursor: null, hasNext: false });
        }
        if (request.path === '/v2/sessions') {
            if (request.home === 'b') return Response.json({ sessions: [
                createPlainSessionCurrentProjectionRecordFixture({ id: 'other-home-only', active: true,
                    metadata: { ...metadata, name: 'Other Home' } }),
            ], nextCursor: null, hasNext: false });
            return Response.json(deleted ? { sessions: [], nextCursor: null, hasNext: false }
                : request.url.searchParams.get('cursor')
                    ? { sessions: [c, otherMachine, ineligible], nextCursor: null, hasNext: false }
                    : { sessions: [hidden], nextCursor: 'page-2', hasNext: true });
        }
        return batch.handle(request);
    } });
    const serverId = homes.homes.a!.id;
    storage.setState({ isDataReady: true, sessions: {}, sessionListRowsByServerId: {} });
    const { useWorkflowExistingSessionOptions } = await import('./useWorkflowExistingSessionOptions');
    const hook = await renderHook(({ enabled }) => useWorkflowExistingSessionOptions({ serverId, machineId: 'machine-a', enabled }),
        { initialProps: { enabled: false } });
    expect(hook.getCurrent().existingSessions).toEqual([]);
    expect(homes.requests.some(request => request.home === 'a' && request.path === '/v2/sessions')).toBe(false);
    await hook.rerender({ enabled: true });
    await waitForHomeGovernance(() => expect(hook.getCurrent().existingSessions.some(option => option.sessionId === c.id)).toBe(true));
    // Check cost before the full option list so an archived-row regression
    // reports the unnecessary reads rather than polling for a list it cannot produce.
    expect(batch.componentRequests.filter(request => request.path === `/v2/sessions/${hidden.id}`
        || archived.some(row => request.path === `/v2/sessions/${row.id}`))).toHaveLength(0);
    expect(hook.getCurrent().existingSessions).toEqual([
        { sessionId: c.id, machineId: 'machine-a', label: 'Session C' },
    ]);
    expect(storage.getState().sessions[c.id]).toBeUndefined();
    expect(hook.getCurrent().sessionOptionsStatus).toBe('ready');
    expect(hook.getCurrent().sessionDropCandidates.map(option => option.sessionId).sort()).toEqual(['other-machine', c.id]);
    expect(homes.requests.some(request => request.path === '/v2/sessions/read-batch' && request.home === 'a')).toBe(true);
    expect(homes.requests.some(request => request.path === '/v2/sessions' && request.url.searchParams.get('cursor') === 'page-2')).toBe(true);
    // Archival is a list lifecycle fact: an already displayed unopened Session
    // must disappear even though neither metadata nor its version changed.
    await act(async () => { storage.getState().applyServerScopedSessionListRowPatches(serverId, [
        { sessionId: otherMachine.id, patch: { archivedAt: 42 } },
    ]); });
    expect(hook.getCurrent().sessionDropCandidates.map(option => option.sessionId)).toEqual([c.id]);
    expect(hook.getCurrent().existingSessions.map(option => option.sessionId)).toEqual([c.id]);
    deleted = true;
    await act(async () => { storage.getState().clearSessionListRowsForServerScope(serverId); });
    await waitForHomeGovernance(() => expect(hook.getCurrent().existingSessions).toEqual([]));
    await hook.unmount();
});
