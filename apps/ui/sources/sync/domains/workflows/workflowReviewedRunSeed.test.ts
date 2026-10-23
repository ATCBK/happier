import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkflowDefinitionFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { WorkflowRunAcceptedContextV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { consumeWorkflowEditorDraftSeed } from './workflowEditorDraftSeed';
import { readWorkflowDefinitionDraftSeed, storeWorkflowDefinitionDraftSeed } from './workflowDefinitionDraftSeed';

import {
    buildWorkflowReviewedRunSeed,
    readWorkflowReviewedRunSeed,
    storeWorkflowReviewedRunSeed,
} from './workflowReviewedRunSeed';

let previousState = storage.getState();
let previousSnapshot = getAppliedActiveServerSnapshot();
let previousAvailable = isAppliedActiveServerRuntimeAvailable();

const ACCEPTED_CONTEXT = WorkflowRunAcceptedContextV1Schema.parse({
    startedBy: 'user',
    source: { kind: 'inline' },
    inputs: { topic: 'release' },
    machineId: 'machine-1',
    executionTarget: { kind: 'detached_run' },
    materializedLeaves: [],
    frozenChildren: {},
    workspaceTarget: { project: { machineId: 'machine-1', directory: '/Users/me/project', checkoutRootPath: '/Users/me/project' } },
    origin: { kind: 'direct' },
});

describe('workflow reviewed-run seed', () => {
    it('pins each accepted root step target rather than re-reading the current role runs-as', () => {
        const definition = createWorkflowDefinitionFixture();
        const seed = buildWorkflowReviewedRunSeed({ run: createWorkflowRunSummaryFixture(), definition,
            acceptedContext: { ...ACCEPTED_CONTEXT, executionTarget: { kind: 'session' }, materializedLeaves: [{
                sourceKey: '$root', blockId: 'analyze', kind: 'step', selection: {}, authoredWorkspace: { kind: 'inherit' },
                executionTarget: { kind: 'detached_run' },
            }] } });
        expect(seed.definition.blocks[0]).toMatchObject({ execution: { executionTarget: { kind: 'detached_run' } } });
        expect(definition.blocks[0]).not.toHaveProperty('execution');
    });
    beforeEach(() => {
        previousState = storage.getState();
        previousSnapshot = getAppliedActiveServerSnapshot();
        previousAvailable = isAppliedActiveServerRuntimeAvailable();
        publishAppliedActiveServerSnapshot({ serverId: 'server-a', serverUrl: 'https://reviewed-seed.test', generation: 1 });
        storage.setState({ profileScope: { serverId: 'server-a', accountId: 'account-a' } });
    });
    afterEach(() => {
        retireActiveServerAccountScopeLifetime();
        storage.setState(previousState);
        publishAppliedActiveServerSnapshot(previousSnapshot, previousAvailable);
    });
    it('keeps accepted library metadata when opening a run as an unsaved workflow', () => {
        const captureProvenance = { discussion: { serverId: 'server-a', discussionId: 'discussion-a' }, messages: [] };
        const seed = buildWorkflowReviewedRunSeed({
            run: createWorkflowRunSummaryFixture({ id: 'run-completed' }),
            definition: createWorkflowDefinitionFixture(),
            acceptedContext: { ...ACCEPTED_CONTEXT, metadata: { title: 'Release review', description: 'Review the release changes', captureProvenance } },
        });
        expect(seed).toMatchObject({ name: 'Release review', description: 'Review the release changes', captureProvenance });
        expect(seed.reasonCode).toBeUndefined();
        expect(seed.supersededRunId).toBeUndefined();
    });
    it('carries the accepted definition, placement, runtime and inputs of the run it reviews', () => {
        const definition = createWorkflowDefinitionFixture();
        const seed = buildWorkflowReviewedRunSeed({
            run: createWorkflowRunSummaryFixture({ id: 'run-interrupted', state: 'interrupted' }),
            definition,
            acceptedContext: ACCEPTED_CONTEXT,
            reasonCode: 'workspace_conflict',
        });

        expect(seed).toMatchObject({
            name: 'Analyze the repository',
            project: { machineId: 'machine-1', directory: '/Users/me/project' },
            // Repeating effectful work under a different runtime would be a
            // different operation; the reviewed copy keeps what was accepted.
            executionTarget: { kind: 'detached_run' },
            inputs: { topic: 'release' },
            supersededRunId: 'run-interrupted',
            reasonCode: 'workspace_conflict',
        });
        expect(seed.definition).toEqual(definition);
    });

    it('keeps the stored copy readable until an editor commits its intake', () => {
        const seed = buildWorkflowReviewedRunSeed({
            run: createWorkflowRunSummaryFixture({ id: 'run-1' }),
            definition: createWorkflowDefinitionFixture(),
            acceptedContext: ACCEPTED_CONTEXT,
            reasonCode: 'workspace_unavailable',
        });
        const seedId = storeWorkflowReviewedRunSeed(seed);

        expect(readWorkflowReviewedRunSeed(seedId)).toEqual(seed);
        expect(readWorkflowReviewedRunSeed(seedId)).toEqual(seed);
        consumeWorkflowEditorDraftSeed(seedId);
        expect(readWorkflowReviewedRunSeed(seedId)).toBeNull();
    });

    it('refuses a handle that does not name a reviewed-run copy', () => {
        expect(readWorkflowReviewedRunSeed('not-a-stored-seed')).toBeNull();
        const seed = { name: 'Portable copy', definition: createWorkflowDefinitionFixture() };
        const id = storeWorkflowDefinitionDraftSeed(seed);
        expect(readWorkflowReviewedRunSeed(id)).toBeNull();
        expect(readWorkflowDefinitionDraftSeed(id)).toEqual(seed);
    });

    it('refuses a seed after the Account changes before editor intake', () => {
        const seedId = storeWorkflowReviewedRunSeed(buildWorkflowReviewedRunSeed({
            run: createWorkflowRunSummaryFixture(),
            definition: createWorkflowDefinitionFixture(),
            acceptedContext: ACCEPTED_CONTEXT,
        }));
        storage.setState({ profileScope: { serverId: 'server-a', accountId: 'account-b' } });
        expect(readWorkflowReviewedRunSeed(seedId)).toBeNull();
    });

    it('refuses a seed after its Account lifetime retires even when the same Account returns', async () => {
        const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const seedId = storeWorkflowReviewedRunSeed(buildWorkflowReviewedRunSeed({
            run: createWorkflowRunSummaryFixture(),
            definition: createWorkflowDefinitionFixture(),
            acceptedContext: ACCEPTED_CONTEXT,
        }));
        retireActiveServerAccountScopeLifetime();
        expect(readWorkflowReviewedRunSeed(seedId)).toBeNull();
    });

});
