import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { AppShellActionOutputSchemas } from '@happier-dev/protocol/actions/appShellActionFamily';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { projectWork } from '@/components/sessions/work/workProjection';
import { createActionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { createActionOperationSelectors } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { registerMountedWorkReadOwner, invokeMountedWorkRead } from './mountedWorkReadAction';
import { registerMountedInboxReadOwner } from './mountedWorkReadAction';
import { ApprovalRequestV2Schema, buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol';
import { buildInboxWorkGroups } from '@/activity/presentation/buildInboxWorkGroups';
import { createAutomationRunFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createInboxAttentionFixture } from '@/dev/testkit/fixtures/inboxFixtures';
import { workflowRunRowFromAutomationRun } from '@/sync/store/domains/workflowRuns';
import type { InboxModel } from '@/hooks/inbox/useInboxModel';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { serveSessionActionHome } from '@/dev/testkit/harness/sessionActionHome';

it('reads approval and Automation rows from the canonical Inbox grouping without disclosing their private content', async () => {
    const home = await serveSessionActionHome();
    const serverId = home.serverId;
    const run = createAutomationRunFixture({ id: 'weekly-run' });
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'agent', sessionId: 'step' }, requestedSurface: 'agent',
        actionId: 'session.title.set', actionArgs: { sessionId: 'step', title: 'Private approval content' }, summary: 'Set title',
        executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', serverId,
            caller: { kind: 'automationRun', automationId: run.automationId, runId: run.id,
                cause: { kind: 'manual', invokedAt: 1 } }, runId: run.id, sessionId: 'step',
            actionId: 'session.title.set', requestId: 'request-1' } });
    const approval: DecryptedArtifact = { id: 'approval-1', title: 'Set title',
        header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request), sessions: ['step'],
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, isDecrypted: true };
    const groups = buildInboxWorkGroups({ sessionEntries: [], workflowRuns: [],
        automationRuns: [workflowRunRowFromAutomationRun(run)], automationServerId: serverId, openApprovals: [approval],
        stalledSessions: [], landings: [], snoozed: [], resolveSession: () => null, resolveOriginRunId: () => null });
    const model: InboxModel = {
        source: { isDataReady: true, sessionsById: {}, sessionListRowsByServerId: {},
            ordinarySessionListMembershipByServerId: {}, sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: {} },
        ...createInboxAttentionFixture(serverId),
        automationAttentionItems: [{ key: `automation-run:${run.id}`, run,
            route: { pathname: '/automations/[id]/runs/[runId]', params: { id: run.automationId, runId: run.id } } }],
        openApprovals: [approval], openUsageNotices: [], friendRequests: [],
        sessionPresentation: { sessionsNeedingAttention: [], readySessions: [], markAllReadTargets: [], pendingRequestHydrationTargets: [] },
        workGroups: groups, targetBySessionAddress: new Map(), actionOperationEntries: [], pendingReadKeys: new Set(),
        markAllPending: false, isLoading: false, hasPrimaryAttention: true, hasContent: true, showCaughtUp: false, spansHomes: false,
        dismissUsageNotice: async () => {}, markRead: async () => {}, resolveActionOperation: () => {},
        settle: async () => {}, setReminder: async () => {},
    };
    let current = true;
    let snapshot = model;
    const remove = registerMountedInboxReadOwner({ scope: { serverId, accountId: 'session-account' },
        isCurrent: () => current, read: () => snapshot });
    const context = { surface: 'cli' as const, serverId, runtimeAccountId: 'session-account' };
    const { createFrontDoorActionExecute } = await import('./frontDoorRuntimeActionExecutor');
    const execute = createFrontDoorActionExecute();
    try {
        const response = await execute('inbox.get', {}, context);
        expect(response.ok).toBe(true);
        if (!response.ok) throw new Error('Expected a readable mounted Inbox');
        const result = AppShellActionOutputSchemas['inbox.get'].parse(response.result);
        expect(result).toMatchObject({ status: 'ready', approvalIds: [approval.id], automationRunIds: [run.id],
            groups: [{ key: groups[0]!.key,
                root: { kind: 'automation', serverId, automationId: run.automationId, runId: run.id },
                items: [{ kind: 'automation_run', key: `automation-run:${run.id}`, runId: run.id },
                    { kind: 'approval', key: `approval:${approval.id}`, artifactId: approval.id }] }] });
        expect(JSON.stringify(result)).not.toContain('Private approval content');
        expect(JSON.stringify(result)).not.toContain('actionArgs');
        expect(await invokeMountedWorkRead({ actionId: 'inbox.get', input: {},
            context: { ...context, runtimeAccountId: 'different-account' } })).toEqual({ status: 'unavailable' });
        snapshot = { ...model, workGroups: [{ ...groups[0]!, root: { kind: 'automation', serverId: 'home-b',
            automationId: run.automationId, runId: run.id } }] };
        expect(await invokeMountedWorkRead({ actionId: 'inbox.get', input: {}, context })).toEqual({ status: 'unavailable' });
        snapshot = model;
        current = false;
        expect(await invokeMountedWorkRead({ actionId: 'inbox.get', input: {}, context })).toEqual({ status: 'unavailable' });
        current = true;
        remove();
        expect(await execute('inbox.get', {}, context)).toMatchObject({ ok: true, result: { status: 'unavailable' } });
    } finally { remove(); await home.dispose(); }
});

describe('mounted canonical Work reads', () => {
    it('serves UI and CLI reads through the production App shell binding and withdraws them on unmount', async () => {
        const home = await serveSessionActionHome();
        const { createFrontDoorActionExecute } = await import('./frontDoorRuntimeActionExecutor');
        const execute = createFrontDoorActionExecute();
        const scope = { serverId: home.serverId, accountId: 'session-account' };
        const projection = projectWork({ sessionId: 'lead', reportSessions: [], agentEntries: [],
            workflowHeadlineRuns: [], managedRuns: [], ownTriggerRunIds: new Set(),
            describeAgentStatus: () => '', describeProgress: () => '' });
        const remove = registerMountedWorkReadOwner({ scope, sessionId: 'lead', isCurrent: () => true,
            read: () => ({ projection, transcriptLoaded: true, managedRuns: { phase: 'loaded', refreshFailed: false } }) });
        try {
            for (const surface of ['ui', 'cli'] as const) {
                const response = await execute('session.work.get', { sessionId: 'lead' },
                    { surface, serverId: scope.serverId, runtimeAccountId: scope.accountId });
                expect(response).toMatchObject({ ok: true, result: { status: 'ready', items: [], summary: projection.summary } });
                if (!response.ok) throw new Error('Expected production App shell Work binding');
                expect(AppShellActionOutputSchemas['session.work.get'].parse(response.result)).toEqual(response.result);
            }
            remove();
            expect(await execute('session.work.get', { sessionId: 'lead' },
                { surface: 'ui', serverId: scope.serverId, runtimeAccountId: scope.accountId }))
                .toMatchObject({ ok: true, result: { status: 'unavailable' } });
        } finally { remove(); await home.dispose(); }
    });

    it('reads the canonical projection through the Action boundary and fences retirement, exact scope and unmount', async () => {
        let current = true;
        const operations = createActionOperationStore();
        operations.mergeSnapshots({ serverId: 'home-a', snapshots: [{
            version: 1, operationId: 'command', revision: 1, actionId: 'projects.script.run',
            state: 'accepted', scope: { accountId: 'account-a', machineId: 'machine', sessionId: 'lead' },
            title: 'Build', createdAt: 1, cancellation: 'supported',
            domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'target-home',
                machineId: 'private-target-machine', workspaceRefId: 'workspace', cwd: '/repo' },
        }] });
        const projection = projectWork({
            sessionId: 'lead', reportSessions: [], agentEntries: [], workflowHeadlineRuns: [],
            serverId: 'home-a', accountId: 'account-a',
            actionOperations: createActionOperationSelectors().selectForSession(operations.getSnapshot(),
                { serverId: 'home-a', accountId: 'account-a', sessionId: 'lead' }),
            describeOperationStatus: () => 'Running',
            managedRuns: [{ run: { id: 'run-a', state: 'running' }, title: 'Review', word: 'Running', needsAttention: true }],
            ownTriggerRunIds: new Set(), describeAgentStatus: () => '', describeProgress: () => '',
        });
        const remove = registerMountedWorkReadOwner({
            scope: { serverId: 'home-a', accountId: 'account-a' }, sessionId: 'lead',
            isCurrent: () => current,
            read: () => ({ projection, transcriptLoaded: true, managedRuns: { phase: 'loaded', refreshFailed: false } }),
        });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            appShellAction: invokeMountedWorkRead,
        }));
        const context = { surface: 'agent' as const, authority: 'account_automation' as const,
            serverId: 'home-a', runtimeAccountId: 'account-a' };
        try {
            const result = await executor.execute('session.work.get', { sessionId: 'lead' }, context);
            expect(result.ok).toBe(true);
            if (!result.ok) throw new Error('Expected a readable mounted Work projection');
            expect(AppShellActionOutputSchemas['session.work.get'].parse(result.result)).toEqual(result.result);
            expect(result).toMatchObject({ ok: true, result: { status: 'ready', summary: projection.summary,
                items: expect.arrayContaining([expect.objectContaining({ key: 'run:run-a', title: 'Review', status: projection.workflows[0]!.status }),
                    expect.objectContaining({ key: projection.projectCommands[0]!.key,
                        open: projection.projectCommands[0]!.open })]) } });
            const serialized = JSON.stringify(result);
            expect(serialized).not.toContain('domainRef');
            expect(serialized).not.toContain('private-target-machine');
            expect(serialized).not.toContain('retry');
            for (const mismatch of [{ serverId: 'home-b' }, { runtimeAccountId: 'account-b' }]) {
                await expect(executor.execute('session.work.get', { sessionId: 'lead' }, { ...context, ...mismatch }))
                    .resolves.toMatchObject({ ok: true, result: { status: 'unavailable' } });
            }
            await expect(executor.execute('session.work.get', { sessionId: 'other' }, context))
                .resolves.toMatchObject({ ok: true, result: { status: 'unavailable' } });
            current = false;
            await expect(executor.execute('session.work.get', { sessionId: 'lead' }, context))
                .resolves.toMatchObject({ ok: true, result: { status: 'unavailable' } });
        } finally { remove(); }
        await expect(executor.execute('session.work.get', { sessionId: 'lead' }, context))
            .resolves.toMatchObject({ ok: true, result: { status: 'unavailable' } });
    });

    it('never describes absent sources or a first read as an empty ready projection', async () => {
        const projection = projectWork({ sessionId: 'lead', reportSessions: [], agentEntries: [],
            workflowHeadlineRuns: [], managedRuns: [], ownTriggerRunIds: new Set(),
            describeAgentStatus: () => '', describeProgress: () => '' });
        const remove = registerMountedWorkReadOwner({ scope: { serverId: 'home', accountId: 'account' },
            sessionId: 'lead', isCurrent: () => true,
            read: () => ({ projection, transcriptLoaded: false, managedRuns: { phase: 'loading', refreshFailed: false } }) });
        try {
            expect(await invokeMountedWorkRead({ actionId: 'session.work.get', input: { sessionId: 'lead' },
                context: { surface: 'ui', serverId: 'home', runtimeAccountId: 'account' } }))
                .toMatchObject({ status: 'loading' });
        } finally { remove(); }
    });

    it('does not disclose a snapshot when its captured owner retires while reading', async () => {
        let current = true;
        const projection = projectWork({ sessionId: 'lead', reportSessions: [], agentEntries: [],
            workflowHeadlineRuns: [], managedRuns: [], ownTriggerRunIds: new Set(),
            describeAgentStatus: () => '', describeProgress: () => '' });
        const remove = registerMountedWorkReadOwner({ scope: { serverId: 'home', accountId: 'account' },
            sessionId: 'lead', isCurrent: () => current,
            read: () => { current = false; return { projection, transcriptLoaded: true, managedRuns: { phase: 'loaded', refreshFailed: false } }; } });
        try {
            expect(await invokeMountedWorkRead({ actionId: 'session.work.get', input: { sessionId: 'lead' },
                context: { surface: 'ui', serverId: 'home', runtimeAccountId: 'account' } }))
                .toEqual({ status: 'unavailable' });
        } finally { remove(); }
    });

    it('shares an exact producer address across equivalent mounts and accepts proven empty work', async () => {
        const projection = projectWork({ sessionId: 'lead', reportSessions: [], agentEntries: [],
            workflowHeadlineRuns: [], managedRuns: [], ownTriggerRunIds: new Set(),
            describeAgentStatus: () => '', describeProgress: () => '' });
        const owner = { scope: { serverId: 'home', accountId: 'account' }, sessionId: 'lead', isCurrent: () => true,
            read: () => ({ projection, transcriptLoaded: true, managedRuns: { phase: 'loaded' as const, refreshFailed: false } }) };
        const first = registerMountedWorkReadOwner(owner);
        const second = registerMountedWorkReadOwner({ ...owner });
        const read = () => invokeMountedWorkRead({ actionId: 'session.work.get', input: { sessionId: 'lead' },
            context: { surface: 'ui', serverId: 'home', runtimeAccountId: 'account' } });
        try {
            expect(await read()).toMatchObject({ status: 'ready', items: [], summary: projection.summary });
            first();
            expect(await read()).toMatchObject({ status: 'ready', items: [], summary: projection.summary });
            second();
            expect(await read()).toEqual({ status: 'unavailable' });
        } finally { first(); second(); }
    });
});
