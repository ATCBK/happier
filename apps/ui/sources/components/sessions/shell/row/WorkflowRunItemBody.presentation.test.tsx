import * as React from 'react';
import { StyleSheet } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { afterEach, expect, it } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { storage } from '@/sync/domains/state/storage';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';
import { formatShortRelativeTimeAt } from '@/utils/time/formatShortRelativeTime';
import { t } from '@/text';

import { WorkflowRunItemBody } from './WorkflowRunItemBody';
import { SessionListHeaderItem } from '../sessionListHeaderItem';
import { buildSessionListProjectHeaderViewModels } from '../sessionListProjectHeaderViewModels';
import { buildSessionListReachabilitySummary } from '../buildSessionListReachabilitySummary';
import { computeVisibleSessionListIndex } from '@/sync/domains/session/listing/computeVisibleSessionListIndex';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';

afterEach(() => { standardCleanup(); storage.setState(storage.getInitialState(), true); });

it('renders distinct machine lines for Run-derived headers sharing the same project path', async () => {
    const machines = ['laptop-a', 'laptop-b'].map(id => createMachineFixture({ id,
        metadata: { ...createMachineFixture().metadata!, displayName: 'Laptop', host: 'laptop.local' },
    }));
    const listItems = computeVisibleSessionListIndex({ source: [], resolveSessionRow: () => null,
        hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {},
        sessionListLayoutChoice: 'projects', presentation: { enabled: false, presentation: 'grouped' },
        workFilter: normalizeSessionListFilterV1({ show: 'runs', homeServerIds: ['home'] }),
        viewerAccountIdByServerId: new Map([['home', 'run-viewer']]),
        workflowRuns: machines.map(machine => ({ serverId: 'home', summary: createWorkflowRunSummaryFixture({
            id: machine.id, ownerAccountId: 'run-viewer', startedBy: 'user', where: { machineId: machine.id, directory: '/home/happier' },
        }) })),
    })!;
    const machinesById = new Map(machines.map(machine => [machine.id, machine]));
    const { projectHeaderViewModelByGroupKey } = buildSessionListProjectHeaderViewModels({
        listItems, machinesById, workspaceLabels: undefined, workspaceRefs: [],
    });
    const { hasMultipleMachines } = buildSessionListReachabilitySummary({
        listItems, machinesById, workspaceRefs: [], resolveSessionRenderable: () => null,
    });
    const headers = listItems.filter(item => item.type === 'header');
    expect(headers).toHaveLength(2);
    const screen = await renderScreen(<>{headers.map(item => <SessionListHeaderItem key={item.groupKey} item={item}
        collapsedKeys={{}} projectHeaderViewModelByGroupKey={projectHeaderViewModelByGroupKey}
        hasMultipleMachines={hasMultipleMachines} newSessionEnabled={false}
        onOpenProject={() => {}} onCreateSessionFromWorkspaceScope={() => {}}
        onAddFolderToWorkspace={() => {}} onRenameWorkspace={() => {}}
        onResetWorkspaceName={() => {}} onToggleCollapse={() => {}} />)}</>);
    const names = [...resolveMachineDisplayNames(machines).values()];
    expect(new Set(names).size).toBe(2);
    for (const name of names) expect(screen.getTextContent()).toContain(name);
});

it('uses the shared attention word for a held Run before its attention window catches up', async () => {
    const run = createWorkflowRunSummaryFixture({ id: 'held-run', state: 'waiting_for_review', attentionRequired: false });
    storage.setState({ profileScope: { serverId: 'home', accountId: 'account' } });
    storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(run,
        { kind: 'available', value: { title: 'Prepare the 0.3 release' } })]);
    const screen = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId={run.id} serverId="home" />);
    expect(screen.getTextContent()).toContain(t('workStatus.buckets.needs_you'));
    expect(screen.getTextContent()).toContain('Prepare the 0.3 release');
    expect(storage.getState().workflowRunsById[run.id]?.detail).toBeUndefined();
});

it('identifies a finished history Run by its frozen workflow name and visible age without opening a body', async () => {
    const run = createWorkflowRunSummaryFixture({ id: 'history-run', state: 'succeeded' });
    storage.setState({ profileScope: { serverId: 'home', accountId: 'account' } });
    storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(run,
        { kind: 'available', value: { title: 'Release review' } })]);
    const screen = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId={run.id} serverId="home" />);
    expect(screen.getTextContent()).toContain('Release review');
    expect(screen.findByTestId(`workflow-run-row:${run.id}:age`)).toBeTruthy();
    expect(screen.getTextContent()).toContain(formatShortRelativeTimeAt(Date.parse(run.updatedAt), Date.now()));
    expect(storage.getState().workflowRunsById[run.id]?.detail).toBeUndefined();
});

it('shows observed authored-step progress and trigger origin together on the Run context line', async () => {
    const run = createWorkflowRunSummaryFixture({ id: 'triggered-run', state: 'running', startedBy: 'trigger',
        stepProgress: { completed: 3, total: 5 } });
    storage.setState({ profileScope: { serverId: 'home', accountId: 'account' } });
    storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(run,
        { kind: 'available', value: { title: 'Prepare the release' } })]);
    const screen = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId={run.id} serverId="home" />);
    expect(screen.getTextContent()).toContain(`${t('workflows.list.stepsProgress', run.stepProgress!)} · ${t('workflows.list.startedByTrigger')}`);
    expect(storage.getState().workflowRunsById[run.id]?.detail).toBeUndefined();
});

it('says an interrupted Run in its word alone, with no tinted row, as a Session row says it (lab convo-N4)', async () => {
    const run = createWorkflowRunSummaryFixture({ id: 'interrupted-run', state: 'interrupted' });
    storage.setState({ profileScope: { serverId: 'home', accountId: 'account' } });
    storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(run,
        { kind: 'available', value: { title: 'Nightly dependency check' } })]);
    const screen = await renderScreen(<WorkflowRunItemBody kind="workflow_run" runId={run.id} serverId="home" />);
    const { theme } = useUnistyles();
    const tinted = screen.findAllByType('View').map((node) => StyleSheet.flatten(node.props.style))
        .filter((style) => style?.backgroundColor === theme.colors.state.warning.background);
    expect(screen.findByTestId(`workflow-run-row:${run.id}:status`)).toBeTruthy();
    expect(tinted).toHaveLength(0);
});
