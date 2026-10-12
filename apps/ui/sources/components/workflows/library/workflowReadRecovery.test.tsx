import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { createWorkflowDefinitionFixture, createWorkflowInvocationIndexFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { useWorkflowReferenceDefinition } from '../presentation/useWorkflowReferenceDefinition';
import { useWorkflowRunRolePrefill } from '../run/useWorkflowRunRolePrefill';
import { useWorkflowRunVisibility } from '../run/useWorkflowRunVisibility';
import { useWorkflowTestRunPresentation } from '../editor/useWorkflowTestRunPresentation';

// The Action transport is the external boundary; every reader, parser and store stays real.
const transport = vi.hoisted(() => vi.fn());
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({ createFrontDoorActionExecute: () => transport }));
const sourceArtifactId = '00000000-0000-4000-8000-000000000001';
const runId = '00000000-0000-4000-8000-000000000002';
let previous = storage.getState();
let applied = getAppliedActiveServerSnapshot();
let available = isAppliedActiveServerRuntimeAvailable();

beforeEach(() => {
    previous = storage.getState();
    applied = getAppliedActiveServerSnapshot();
    available = isAppliedActiveServerRuntimeAvailable();
    publishAppliedActiveServerSnapshot({ serverId: 'recovery-home', serverUrl: 'http://workflow-recovery.test', generation: 1 });
    storage.setState({ profileScope: { serverId: 'recovery-home', accountId: 'recovery-account' } });
    transport.mockReset();
});
afterEach(async () => {
    await standardCleanup();
    retireActiveServerAccountScopeLifetime();
    storage.setState(previous);
    publishAppliedActiveServerSnapshot(applied, available);
});

describe('Workflow sibling read recovery', () => {
    it('replaces a retired Role-prefill read without waiting for its old response', async () => {
        transport.mockReturnValueOnce(createDeferred<unknown>().promise)
            .mockResolvedValue({ ok: true, result: { runs: [], metadataByRunId: {} } });
        const hook = await renderHook(() => useWorkflowRunRolePrefill(sourceArtifactId));
        expect(hook.getCurrent().status).toBe('loading');
        await act(async () => retireActiveServerAccountScopeLifetime());
        expect(hook.getCurrent().status).toBe('ready');
        expect(hook.getCurrent().overrides).toEqual([]);
    });

    it('replaces retired grant visibility and saved-reference reads together', async () => {
        const definition = createWorkflowDefinitionFixture();
        transport.mockImplementation((action: string) => Promise.resolve({ ok: true, result: action === 'workflow.definition.get'
            ? { definitionId: sourceArtifactId, definition, access: 'owner', revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Saved' } }
            : { artifactId: sourceArtifactId, ownerAccountId: 'recovery-account', access: 'owner', grants: [] } }));
        const hook = await renderHook(() => ({
            reference: useWorkflowReferenceDefinition(sourceArtifactId),
            visibility: useWorkflowRunVisibility(sourceArtifactId),
        }));
        expect(hook.getCurrent().reference.definition).toEqual(definition);
        expect(hook.getCurrent().visibility.status).toBe('ready');
        await act(async () => retireActiveServerAccountScopeLifetime());
        expect(hook.getCurrent().reference.definition).toEqual(definition);
        expect(hook.getCurrent().visibility.status).toBe('ready');
    });

    it('renews the editor Test-run read and its subsequent Home wake', async () => {
        const invocation = createWorkflowInvocationIndexFixture({ id: '00000000-0000-4000-8000-000000000003', lifecycle: 'running', sequence: '1' });
        transport.mockReturnValueOnce(createDeferred<unknown>().promise)
            .mockResolvedValue({ ok: true, result: { invocations: [invocation], parentRevision: 1 } });
        await renderHook(() => useWorkflowTestRunPresentation({ runId, definition: createWorkflowDefinitionFixture(), editable: true }));
        await act(async () => retireActiveServerAccountScopeLifetime());
        expect(storage.getState().workflowRunInvocationsByRunId[runId]?.factsById[invocation.id]?.lifecycle).toBe('running');
        const completed = createWorkflowInvocationIndexFixture({ ...invocation, lifecycle: 'completed', sequence: '2', contentRevision: '2' });
        transport.mockResolvedValue({ ok: true, result: { invocations: [completed], parentRevision: 2 } });
        await act(async () => publishHomeAccountChange('recovery-home', [`workflow-run:${runId}`]));
        expect(storage.getState().workflowRunInvocationsByRunId[runId]?.factsById[invocation.id]?.lifecycle).toBe('completed');
    });
});
