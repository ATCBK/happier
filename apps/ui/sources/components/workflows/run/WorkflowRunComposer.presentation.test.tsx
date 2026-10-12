import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createWorkflowDefinitionFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { t } from '@/text';

import { WorkflowRunComposer } from './WorkflowRunComposer';

afterEach(standardCleanup);

it('names every accepted execution kind in the read-only targets chip', async () => {
    const screen = await renderScreen(<WorkflowRunComposer inputs={[]} values={{}}
        onChangeValues={() => {}} onRun={() => {}} onCancel={() => {}}
        definition={createWorkflowDefinitionFixture()} materializedLeaves={[
            { sourceKey: '$root', blockId: 'build', kind: 'step', selection: {},
                authoredWorkspace: { kind: 'inherit' }, executionTarget: { kind: 'session' } },
            { sourceKey: 'accepted-child', blockId: 'check', kind: 'step', selection: {},
                authoredWorkspace: { kind: 'inherit' }, executionTarget: { kind: 'detached_run' } },
        ]} />);
    const label = screen.findByTestId('workflow-run-inputs-targets-chip')?.props.accessibilityLabel;
    expect(label).toContain(t('workflows.start.targetsSessions'));
    expect(label).toContain(t('workflows.start.targetsBackground'));
});

it('keeps the admission status readable while Start is pending and cannot be submitted again', async () => {
    const onRun = vi.fn();
    const screen = await renderScreen(<WorkflowRunComposer inputs={[]} values={{}} pending
        onChangeValues={() => {}} onRun={onRun} onCancel={() => {}} />);
    expect(screen.findByTestId('workflow-run-inputs-starting')?.props.children).toBe(t('workflows.start.starting'));
    // The pressed Start keeps its own label, width and primary look under its spinner (DESIGN-16 D11);
    // the line beside it says it is starting.
    const start = screen.tree.root.findAll((node) => node.props?.testID === 'workflow-run-inputs-run' && node.props.title !== undefined)[0];
    expect(start?.props.title).toBe(t('workflows.start.start'));
    expect(start?.props.loading).toBe(true);
    expect(start?.props.disabled).toBe(false);
    await screen.pressByTestIdAsync('workflow-run-inputs-run');
    expect(onRun).not.toHaveBeenCalled();
});
