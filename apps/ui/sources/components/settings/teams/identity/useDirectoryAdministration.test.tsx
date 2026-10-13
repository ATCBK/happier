import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TeamDirectorySourceRemovalPreflightV1Schema, TeamDirectorySourceSummaryV1Schema, type TeamDirectorySourceSummaryV1 } from '@happier-dev/protocol/teams';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({ storage: 'real' });

// Keep the real Actions policy, Artifact lifecycle, response parser and hook
// state transitions. Only the Home network and device credential store change.
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { useActionApprovalContinuation } = await import('@/components/approvals/useActionApprovalContinuation');
const { serverAccountScopedTeamKey, serverAccountScopedTeamResourceKey } = await import('@/sync/domains/teams/teamAddress');
const { useDirectoryAdministration, useDirectorySourceAdministration } = await import('./useDirectoryAdministration');
const { useDirectoryPeopleList } = await import('./DirectoryPeopleList');

const ACCOUNT_ID = 'account-directory';
const LIST_PATH = '/v1/teams/team-1/directory-sources';
const SOURCE_PATH = `${LIST_PATH}/source-1`;
const PREVIEW_PATH = `${SOURCE_PATH}/removal-impact`;
const onExecuted = () => undefined;

function directorySource(id: string, teamId = 'team-1'): TeamDirectorySourceSummaryV1 {
    return TeamDirectorySourceSummaryV1Schema.parse({
        v: 1,
        id,
        teamId,
        kind: 'workos_directory',
        displayName: id,
        state: 'active',
        allowedActions: ['teams.directory.sources.remove'],
        sync: {
            mode: 'events_and_full',
            attempt: 'succeeded',
            freshness: 'fresh',
            lastAttemptAt: null,
            lastSuccessAt: null,
            lastFullReconcileAt: null,
            nextScheduledAt: null,
        },
        error: null,
    });
}

const removalImpact = TeamDirectorySourceRemovalPreflightV1Schema.parse({
    v: 1,
    status: 'allowed',
    sourceId: 'source-1',
    sourceLabel: 'Directory One',
    impact: {
        teamMembershipsRemoved: 2,
        groupMembershipsRemoved: 3,
        groupContributionsRemoved: 4,
        directoryCreatedGroupsRetained: 1,
        nativeMembershipsPreserved: 5,
        nativeGroupContributionsPreserved: 6,
    },
});

async function addHome(): Promise<ServerAccountScope> {
    const serverId = await harness.addHome({
        name: 'Directory Home',
        serverUrl: 'https://directory-read-approval.example',
        accountId: ACCOUNT_ID,
        teamsEnabled: true,
    });
    return { serverId, accountId: ACCOUNT_ID };
}

async function renderList(scope: ServerAccountScope) {
    return await renderHook((props: { scope: ServerAccountScope; teamId: string }) => {
        const approval = useActionApprovalContinuation({
            serverId: props.scope.serverId,
            scopeKey: serverAccountScopedTeamKey(props.scope, { serverId: props.scope.serverId, teamId: props.teamId }),
            onExecuted,
        });
        const directory = useDirectoryAdministration(props.scope, props.teamId, true, approval.requestApproval);
        return { approval, directory };
    }, { initialProps: { scope, teamId: 'team-1' } });
}

async function renderSource(scope: ServerAccountScope) {
    return await renderHook((props: { sourceId: string }) => {
        const approval = useActionApprovalContinuation({
            serverId: scope.serverId,
            scopeKey: serverAccountScopedTeamResourceKey(scope, { serverId: scope.serverId, teamId: 'team-1' }, 'directory-source', props.sourceId),
            onExecuted,
        });
        const directory = useDirectorySourceAdministration(scope, 'team-1', props.sourceId, approval.requestApproval);
        return { approval, directory };
    }, { initialProps: { sourceId: 'source-1' } });
}

describe('mounted directory read approvals', () => {
    beforeEach(async () => {
        standardCleanup();
        await harness.reset();
    });
    afterEach(() => standardCleanup());

    it('delivers the approved source list and continuation page without replaying either read', async () => {
        const scope = await addHome();
        await harness.requireUiApproval(scope.serverId, 'teams.directory.sources.list');
        harness.answer(scope.serverId, LIST_PATH, { body: { items: [directorySource('source-1')], nextCursor: 'page-2' } });
        harness.answer(scope.serverId, `${LIST_PATH}?cursor=page-2`, { body: { items: [directorySource('source-2')], nextCursor: null } });
        const hook = await renderList(scope);
        await waitForHomeGovernance(() => expect(harness.artifacts(scope.serverId).list()).toHaveLength(1));
        expect(hook.getCurrent().directory.state).toEqual({ kind: 'loading' });
        const firstId = harness.artifacts(scope.serverId).list()[0]!.id;

        await expect(decideApprovalAsInbox(scope.serverId, firstId, 'approve')).resolves.toMatchObject({ ok: true, result: { status: 'executed' } });
        await waitForHomeGovernance(() => expect(hook.getCurrent().directory.state).toMatchObject({
            kind: 'ready', items: [{ id: 'source-1' }], nextCursor: 'page-2',
        }));
        let loadMore!: Promise<void>;
        await act(async () => { loadMore = hook.getCurrent().directory.loadMore(); });
        await waitForHomeGovernance(() => expect(harness.artifacts(scope.serverId).list()).toHaveLength(2));
        expect(hook.getCurrent().directory.state).toMatchObject({ kind: 'ready', items: [{ id: 'source-1' }], loadingMore: true });
        const secondId = harness.artifacts(scope.serverId).list()[1]!.id;
        await decideApprovalAsInbox(scope.serverId, secondId, 'approve');
        await act(async () => { await loadMore; });

        expect(hook.getCurrent().directory.state).toMatchObject({
            kind: 'ready', items: [{ id: 'source-1' }, { id: 'source-2' }], nextCursor: null, loadingMore: false,
        });
        expect(harness.requestsFor(LIST_PATH)).toHaveLength(1);
        expect(harness.requestsFor(`${LIST_PATH}?cursor=page-2`)).toHaveLength(1);
        await hook.rerender();
        expect(harness.artifacts(scope.serverId).list()).toHaveLength(2);
    });

    it('shows a rejected read as retryable and completes a fresh explicit retry', async () => {
        const scope = await addHome();
        await harness.requireUiApproval(scope.serverId, 'teams.directory.sources.list');
        harness.answer(scope.serverId, LIST_PATH, { body: { items: [], nextCursor: null } });
        const hook = await renderList(scope);
        await waitForHomeGovernance(() => expect(harness.artifacts(scope.serverId).list()).toHaveLength(1));
        await decideApprovalAsInbox(scope.serverId, harness.artifacts(scope.serverId).list()[0]!.id, 'reject');
        await waitForHomeGovernance(() => expect(hook.getCurrent().directory.state).toMatchObject({
            kind: 'unavailable', failure: { code: 'approval_rejected', retryable: true },
        }));

        await act(async () => hook.getCurrent().directory.refresh());
        await waitForHomeGovernance(() => expect(harness.artifacts(scope.serverId).list()).toHaveLength(2));
        await decideApprovalAsInbox(scope.serverId, harness.artifacts(scope.serverId).list()[1]!.id, 'approve');
        await waitForHomeGovernance(() => expect(hook.getCurrent().directory.state).toMatchObject({ kind: 'ready', items: [] }));
        expect(harness.requestsFor(LIST_PATH)).toHaveLength(1);
    });

    it('ignores an old Team read after the mounted scope changes', async () => {
        const scope = await addHome();
        await harness.requireUiApproval(scope.serverId, 'teams.directory.sources.list');
        harness.answer(scope.serverId, LIST_PATH, { body: { items: [directorySource('source-old')], nextCursor: null } });
        harness.answer(scope.serverId, '/v1/teams/team-2/directory-sources', { body: { items: [directorySource('source-new', 'team-2')], nextCursor: null } });
        const hook = await renderList(scope);
        await waitForHomeGovernance(() => expect(harness.artifacts(scope.serverId).list()).toHaveLength(1));
        const oldId = harness.artifacts(scope.serverId).list()[0]!.id;
        await hook.rerender({ scope, teamId: 'team-2' });
        await waitForHomeGovernance(() => expect(harness.artifacts(scope.serverId).list()).toHaveLength(2));
        await decideApprovalAsInbox(scope.serverId, harness.artifacts(scope.serverId).list()[1]!.id, 'approve');
        await waitForHomeGovernance(() => expect(hook.getCurrent().directory.state).toMatchObject({ kind: 'ready', items: [{ id: 'source-new' }] }));
        await decideApprovalAsInbox(scope.serverId, oldId, 'approve');
        expect(hook.getCurrent().directory.state).toMatchObject({ kind: 'ready', items: [{ id: 'source-new' }] });
    });

    it('awaits the approved source and removal preview and releases preview custody on unmount', async () => {
        const scope = await addHome();
        await harness.requireUiApproval(scope.serverId, 'teams.directory.sources.get');
        harness.answer(scope.serverId, SOURCE_PATH, { body: directorySource('source-1') });
        harness.answer(scope.serverId, PREVIEW_PATH, { body: removalImpact });
        const hook = await renderSource(scope);
        await waitForHomeGovernance(() => expect(harness.artifacts(scope.serverId).list()).toHaveLength(1));
        expect(hook.getCurrent().directory.state).toEqual({ kind: 'loading' });
        await decideApprovalAsInbox(scope.serverId, harness.artifacts(scope.serverId).list()[0]!.id, 'approve');
        await waitForHomeGovernance(() => expect(hook.getCurrent().directory.state).toMatchObject({ kind: 'ready', item: { id: 'source-1' } }));
        await act(async () => { await harness.requireUiApproval(scope.serverId, 'teams.directory.sources.remove.preview'); });

        let preview!: ReturnType<ReturnType<typeof hook.getCurrent>['directory']['readRemovalImpact']>;
        await act(async () => { preview = hook.getCurrent().directory.readRemovalImpact(); });
        await waitForHomeGovernance(() => expect(harness.artifacts(scope.serverId).list()).toHaveLength(2));
        expect(hook.getCurrent().directory.pendingAction).toBe('removal-impact');
        await decideApprovalAsInbox(scope.serverId, harness.artifacts(scope.serverId).list()[1]!.id, 'approve');
        await act(async () => { await expect(preview).resolves.toEqual({ ok: true, value: removalImpact }); });
        expect(hook.getCurrent().directory.pendingAction).toBeNull();
        expect(harness.requestsFor(SOURCE_PATH)).toHaveLength(1);
        expect(harness.requestsFor(PREVIEW_PATH)).toHaveLength(1);

        await act(async () => { preview = hook.getCurrent().directory.readRemovalImpact(); });
        await waitForHomeGovernance(() => expect(harness.artifacts(scope.serverId).list()).toHaveLength(3));
        await hook.unmount();
        await expect(preview).resolves.toMatchObject({ ok: false, failure: { code: 'aborted' } });
        await decideApprovalAsInbox(scope.serverId, harness.artifacts(scope.serverId).list()[2]!.id, 'approve');
        await expect(preview).resolves.toMatchObject({ ok: false, failure: { code: 'aborted' } });
    });

    it('withdraws loaded people when an approved continuation read loses Home authority', async () => {
        const scope = await addHome();
        const peoplePath = `${SOURCE_PATH}/people?limit=50`;
        harness.answer(scope.serverId, peoplePath, { body: {
            items: [{
                v: 1, id: 'person-1', sourceId: 'source-1', externalUserId: 'external-1',
                displayName: 'Ada', email: null, externalLogin: null, state: 'active',
                accountBinding: { state: 'unbound' }, sourceLabel: 'Directory One',
            }],
            nextCursor: 'next-people',
        } });
        const address = { serverId: scope.serverId, teamId: 'team-1' };
        const hook = await renderHook(() => {
            const approval = useActionApprovalContinuation({
                serverId: scope.serverId,
                scopeKey: serverAccountScopedTeamKey(scope, address),
                onExecuted,
            });
            const people = useDirectoryPeopleList({ scope, address, sourceId: 'source-1', requestApproval: approval.requestApproval });
            return { approval, people };
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().people.rows).toMatchObject([{ id: 'person-1' }]));
        await act(async () => { await harness.requireUiApproval(scope.serverId, 'teams.directory.people.list'); });
        const continuationPath = `${peoplePath}&cursor=next-people`;
        harness.answer(scope.serverId, continuationPath, { status: 403, body: { error: 'forbidden' } });
        let loadMore!: Promise<void>;
        await act(async () => { loadMore = hook.getCurrent().people.loadMore(); });
        await waitForHomeGovernance(() => expect(harness.artifacts(scope.serverId).list()).toHaveLength(1));
        expect(hook.getCurrent().people.rows).toMatchObject([{ id: 'person-1' }]);
        await decideApprovalAsInbox(scope.serverId, harness.artifacts(scope.serverId).list()[0]!.id, 'approve');
        await act(async () => { await loadMore; });

        expect(hook.getCurrent().people).toMatchObject({ rows: [], status: 'error', hasMore: false, error: { kind: 'forbidden', retryable: false } });
        expect(harness.requestsFor(peoplePath)).toHaveLength(1);
        expect(harness.requestsFor(continuationPath)).toHaveLength(1);
    });
});
