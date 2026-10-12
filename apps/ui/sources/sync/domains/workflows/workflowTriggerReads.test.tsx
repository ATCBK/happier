import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { storage } from '@/sync/domains/state/storageStore';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { listWorkflowTriggerSets, removeWorkflowTrigger, updateWorkflowTrigger } from './workflowTriggerActions';
import { useWorkflowTriggerSets } from '@/components/workflows/triggers/useWorkflowTriggerSets';
import { useSessionTriggerLastRuns } from '@/components/workflows/triggers/useSessionTriggerLastRuns';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { useServerCredentialAccountScopeStates } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { WorkflowTriggerSetV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';

const execute = vi.hoisted(() => vi.fn());
// Action transport boundary: schemas, Account lifecycle, selectors and store remain real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({ createFrontDoorActionExecute: () => execute }));
let previousState = storage.getState();
let previousSnapshot = getAppliedActiveServerSnapshot();
let previousAvailable = isAppliedActiveServerRuntimeAvailable();

beforeEach(async () => {
    previousState = storage.getState();
    previousSnapshot = getAppliedActiveServerSnapshot();
    previousAvailable = isAppliedActiveServerRuntimeAvailable();
    const runtime = await import('@/sync/domains/server/serverRuntime');
    const profile = await runtime.upsertAndActivateServer({ serverUrl: 'http://trigger-read.test', name: 'Trigger Home' });
    publishAppliedActiveServerSnapshot(runtime.getActiveServerSnapshot());
    storage.setState({ profileScope: { serverId: profile.id, accountId: 'account-one' } });
});
afterEach(async () => {
    standardCleanup();
    (await import('@/components/workflows/library/workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
    (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime();
    storage.setState(previousState);
    publishAppliedActiveServerSnapshot(previousSnapshot, previousAvailable);
    execute.mockReset();
    vi.restoreAllMocks();
});

describe('Account schedule read ownership', () => {
    it('retains the delete receipt revision when an unseen update ACK arrives afterwards', async () => {
        storage.setState({ workflowTriggerSetsById: {}, workflowTriggerSetIdsByQuery: {} });
        const set = WorkflowTriggerSetV1Schema.parse({ automationId: 'delayed-ack', revision: 10,
            enabled: true, health: 'available', triggers: [] });
        storage.getState().applyWorkflowTriggerSetPage({ queryKey: 'account_inline', sets: [set] });
        const pendingUpdate = createDeferred<unknown>();
        execute.mockReturnValueOnce(pendingUpdate.promise);
        const updated = updateWorkflowTrigger({ automationId: set.automationId, expectedRevision: 10, patch: { enabled: false } });
        execute.mockResolvedValueOnce({ ok: true, result: { automationId: set.automationId, deleted: true, removedRevision: 11 } });
        await removeWorkflowTrigger({ automationId: set.automationId });
        storage.getState().applyWorkflowTriggerSetPage({ queryKey: 'account_inline', sets: [] });
        pendingUpdate.resolve({ ok: true, result: { set: { ...set, revision: 11, enabled: false } } });
        await updated;
        expect(storage.getState().workflowTriggerSetsById[set.automationId]).toBeUndefined();
        expect(storage.getState().workflowTriggerSetIdsByQuery.account_inline).toEqual([]);
    });
    it('removes a deleted Manual set from all cached memberships while preserving other sets and Run history', async () => {
        const manual = WorkflowTriggerSetV1Schema.parse({ automationId: 'retained-manual', revision: 3,
            enabled: false, health: 'available', triggers: [] });
        const other = WorkflowTriggerSetV1Schema.parse({ ...manual, automationId: 'unrelated' });
        const history = { 'past-run': workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'past-run',
            state: 'succeeded', origin: { kind: 'automation', automationId: manual.automationId } })) };
        storage.setState({ workflowTriggerSetsById: {}, workflowTriggerSetIdsByQuery: {}, workflowRunsById: history });
        storage.getState().applyWorkflowTriggerSetPage({ queryKey: 'account_inline', sets: [manual, other] });
        storage.getState().applyWorkflowTriggerSetPage({ queryKey: 'account_all', sets: [manual, other] });
        execute.mockResolvedValue({ ok: true, result: { automationId: manual.automationId, deleted: true } });
        expect(await removeWorkflowTrigger({ automationId: manual.automationId }))
            .toEqual({ automationId: manual.automationId, deleted: true });
        expect(storage.getState().workflowTriggerSetsById).toEqual({ unrelated: other });
        expect(storage.getState().workflowTriggerSetIdsByQuery)
            .toEqual({ account_inline: ['unrelated'], account_all: ['unrelated'] });
        expect(storage.getState().workflowRunsById).toBe(history);
    });
    it('reads addressed FIN sets without reading or overwriting the focused Home, and keeps its facts after a failed refresh', async () => {
        const targetId = storage.getState().profileScope!.serverId;
        const serverIds = [targetId];
        const runtime = await import('@/sync/domains/server/serverRuntime');
        const focused = await runtime.upsertAndActivateServer({ serverUrl: 'http://trigger-read-focused.test' });
        publishAppliedActiveServerSnapshot(runtime.getActiveServerSnapshot());
        storage.setState({ profileScope: { serverId: focused.id, accountId: 'focused-owner' },
            workflowTriggerSetsById: {}, workflowTriggerSetIdsByQuery: {} });
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: createAccountTokenForTests('account-one', { currentAccount: true }) });
        const set = WorkflowTriggerSetV1Schema.parse({ automationId: 'addressed-rule', revision: 1, enabled: true, health: 'available',
            triggers: [{ id: 'archive', revision: 1, enabled: true, createdAt: 1, updatedAt: 1, kind: 'sessionLifecycle',
                sourceSessionId: 'source-session', events: ['sessionArchived'], policy: { kind: 'everyMatch' },
                remainingOccurrences: null, status: { state: 'waiting', runId: null }, triggerDefinitionEnvelope: null }] });
        execute.mockResolvedValue({ ok: true, result: { sets: [set] } });
        const hook = await renderHook(() => {
            const scopes = useServerCredentialAccountScopeStates(serverIds);
            const binding = scopes.get(resolveServerProfileScopeIdForIdentifier(targetId))?.binding ?? null;
            return useWorkflowTriggerSets({ scope: 'account_all' }, binding);
        });
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
        expect(hook.getCurrent().sets).toEqual([set]);
        expect(execute.mock.calls.every(([, , context]) => context.serverId === resolveServerProfileScopeIdForIdentifier(targetId)
            && context.runtimeAccountId === 'account-one')).toBe(true);
        expect(storage.getState().workflowTriggerSetsById).toEqual({});
        execute.mockResolvedValue({ ok: false, errorCode: 'temporarily_unavailable', error: 'Unavailable' });
        await act(async () => publishHomeAccountChange(targetId));
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('failed'));
        expect(hook.getCurrent().sets).toEqual([set]);
        const retry = createDeferred<unknown>();
        execute.mockReturnValue(retry.promise);
        await act(async () => hook.getCurrent().retry());
        expect(hook.getCurrent().sets).toEqual([set]);
        await act(async () => retry.resolve({ ok: true, result: { sets: [set] } }));
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
        expect(storage.getState().profileScope?.accountId).toBe('focused-owner');
        await hook.unmount();
    });
    it('pages the shared Account Run window until every relevant habit has its true latest result', async () => {
        execute.mockImplementation(async (_actionId: string, input: { cursor?: string }) => ({ ok: true, result: {
            runs: [createWorkflowRunSummaryFixture(input.cursor
                ? { id: 'habit-run', state: 'failed', origin: { kind: 'automation', automationId: 'habit' } }
                : { id: 'other-run', origin: { kind: 'automation', automationId: 'other' } })], metadataByRunId: {},
            ...(input.cursor ? {} : { nextCursor: 'next' }),
        } }));
        const ids = ['habit'];
        const hook = await renderHook(() => useSessionTriggerLastRuns(ids));
        await vi.waitFor(() => expect(hook.getCurrent().lastRunsByAutomationId.habit?.state).toBe('failed'));
        expect(execute.mock.calls.map((call) => call[1])).toEqual([{}, { cursor: 'next' }]);
    });
    it('shares one read between rail and sidebar without letting one consumer abort the other', async () => {
        const pending = createDeferred<unknown>();
        execute.mockReturnValue(pending.promise);
        const controller = new AbortController();
        const retiredConsumer = listWorkflowTriggerSets({ scope: 'account_all' }, { signal: controller.signal }).catch(() => 'aborted');
        const liveConsumer = listWorkflowTriggerSets({ scope: 'account_all' });
        controller.abort();
        await act(async () => { pending.resolve({ ok: true, result: { sets: [] } }); });
        expect(await retiredConsumer).toBe('aborted');
        expect(await liveConsumer).toEqual([]);
        expect(execute).toHaveBeenCalledTimes(1);
    });
    it('does not re-render or refetch an open Scheduled section for unrelated Run and invocation facts', async () => {
        execute.mockResolvedValue({ ok: true, result: { sets: [] } });
        let renders = 0;
        const hook = await renderHook(() => { renders++; return useWorkflowTriggerSets({ scope: 'account_all' }); });
        expect(hook.getCurrent().status).toBe('ready');
        const before = renders;
        await act(async () => { storage.setState({ workflowRunsById: {}, workflowRunInvocationsByRunId: {} }); });
        expect(renders - before).toBe(0);
        expect(execute).toHaveBeenCalledTimes(1);
    });
});
