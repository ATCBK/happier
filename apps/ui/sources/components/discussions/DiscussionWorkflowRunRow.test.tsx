import 'fake-indexeddb/auto';
import '@happier-dev/protocol/actions/actionApprovalPolicy';
import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { DiscussionMessageV1Schema } from '@happier-dev/protocol/discussions/models';
import { createDiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { DiscussionWorkflowRunRow } = await import('./DiscussionWorkflowRunRow');
const { projectWorkflowRunPublishedAnswerIds } = await import('./prepareDiscussionSelectionHandoff');

afterEach(async () => {
    await standardCleanup();
    await homes.reset();
});

it('offers end-row capture from committed Workflow and Agent answers, bound to the exact Run', async () => {
    const messages = (['agent', 'workflow', 'execution'] as const).map((kind, index) => {
        const committed = DiscussionMessageV1Schema.parse({
            id: `answer-${kind}`, discussionId: 'discussion-a', localId: `answer-${kind}`, seq: index + 1,
            authorAccountId: 'alice', accountActor: { v: 1, accountId: 'alice', profile: null },
            producerV1: kind === 'agent'
                ? { v: 1, kind, sessionId: 'external-plugin-session', runId: 'run-b',
                    replyReturn: { serverId: 'home-a', requestLocalId: 'request-a', outcome: 'answer',
                        workflow: { runId: 'run-a', invocationRecordId: 'invocation-agent', invocationAttempt: '0' } } }
                : kind === 'execution' ? { v: 1, kind: 'agent', sessionId: 'external-plugin-session', runId: 'run-b',
                    replyReturn: { serverId: 'home-a', requestLocalId: 'ordinary-request', outcome: 'answer' } }
                : { v: 1, kind, runId: 'run-a', invocationRecordId: 'invocation-workflow', invocationAttempt: '0',
                    execution: { kind: 'action', actionId: 'external-plugin.answer' }, outcome: 'answer' },
            content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Published answer' }] } },
            mentionedAccountIds: [], createdAt: 1,
        });
        return { ...committed, content: { v: 1 as const, parts: [{ t: 'text' as const, text: 'Published answer' }] },
            messageRef: createDiscussionMessageRefV1({ serverId: 'home-a', discussionId: 'discussion-a' }, committed) };
    });
    const byRun = projectWorkflowRunPublishedAnswerIds(messages);
    const save = vi.fn<(ids: readonly string[]) => void>();
    const props = {
        metadata: null, supportsAnotherRound: false, canEdit: true,
        accountLifetime: { scope: { serverId: 'home-a', accountId: 'alice' }, isCurrent: () => true,
            onRetire: () => ({ dispose: () => undefined }) },
        onStarted: () => undefined, onSaveAsPattern: save,
    };
    // Wrong-Run binding must not borrow another Run's published answers.
    const screen = await renderScreen(<>
        <DiscussionWorkflowRunRow {...props} run={createWorkflowRunSummaryFixture({ id: 'run-a', state: 'failed' })}
            publishedMessageIds={byRun.get('run-a') ?? []} />
        <DiscussionWorkflowRunRow {...props} run={createWorkflowRunSummaryFixture({ id: 'run-b', state: 'failed' })}
            publishedMessageIds={byRun.get('run-b') ?? []} />
    </>);
    expect(screen.findHostByTestId('discussion-workflow-run-save-pattern:run-b')).toBeNull();
    await screen.pressByTestIdAsync('discussion-workflow-run-save-pattern:run-a');
    expect(save).toHaveBeenCalledWith(['answer-agent', 'answer-workflow']);
});
