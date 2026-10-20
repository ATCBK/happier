import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { createWorkNotificationOwnerFixture as ownerFixture } from '@/dev/testkit/harness/workNotificationOwner';
import { getPreferredLanguage, preloadTranslations, setPreferredLanguageFromSettings, t } from '@/text';

// Load the real Account/Action graph during collection, not inside the assertion
// deadline; no service or catalog beneath the component is replaced.
const { RunWorkNotifyOperation } = await import('./RunWorkNotifications');

describe('Session Work notification operation', () => {
  it('refuses registration when the selected saved result is not the Run owner result', async () => {
    const owner = ownerFixture({ runOutputState: 'complete' });
    owner.acceptCreate();
    const screen = await renderScreen(<RunWorkNotifyOperation
      source={{ kind: 'execution_run', machineId: 'machine-one', runId: 'generator' }}
      selectedOutput={{ output: 'commitPlan', comparisonId: 'comparison-one', resultId: 'other-result', message: 'Commit proposal update' }}
      project={{ machineId: 'machine-one', directory: '/workspace' }} read={owner.runRead} execute={owner.execute} />);
    await act(async () => { screen.pressByTestId('notify-run-terminal:generator'); });
    expect(owner.source()).toBeUndefined();
    expect(screen.findByTestId('notify-run-terminal-error:generator')).not.toBeNull();
    expect(screen.findByTestId('notify-run-terminal-armed:generator')).toBeNull();
  });
  it.each(['pending', 'writing', 'complete', 'failed'] as const)('registers and cancels the exact %s output through its Run owner', async (state) => {
    const owner = ownerFixture({ runOutputState: state });
    owner.acceptCreate();
    const screen = await renderScreen(<RunWorkNotifyOperation
      source={{ kind: 'execution_run', machineId: 'machine-one', runId: 'generator' }}
      selectedOutput={{ output: 'commitPlan', comparisonId: 'comparison-one', resultId: 'saved-one', message: 'Commit proposal update' }}
      project={{ machineId: 'machine-one', directory: '/workspace' }} read={owner.runRead} execute={owner.execute} />);
    await act(async () => { screen.pressByTestId('notify-run-terminal:generator'); });
    expect(owner.source()).toEqual({ kind: 'runLifecycle', enabled: true, condition: 'terminal', source: {
      kind: 'execution_run', machineId: 'machine-one', runId: 'generator', observation: { kind: 'scm_diff_summary',
        output: 'commitPlan', comparisonId: 'comparison-one', resultId: 'saved-one',
        ...(['pending', 'writing'].includes(state) ? { afterRevision: 4 } : {}),
      },
    } });
    expect(screen.findByTestId('notify-run-terminal-armed:generator')).not.toBeNull();
    await act(async () => { screen.pressByTestId('notify-run-terminal-cancel:generator'); });
    expect(owner.removedId()).toBe([...owner.rows.values()][0]?.triggers[0]?.id);
    await act(async () => { owner.acceptRemove(); });
    expect([...owner.rows.values()].flatMap(row => row.triggers)).toEqual([]);
  });
  it('registers the exact workflow terminal source and only acknowledges committed registration/removal', async () => {
    const owner = ownerFixture();
    const screen = await renderScreen(
      <RunWorkNotifyOperation
        source={{ kind: 'workflow_run', runId: 'workflow-one' }}
        project={{ machineId: 'machine-one', directory: '/workspace' }}
        read={owner.runRead}
        execute={owner.execute}
      />,
    );
    const { Switch } = await import('@/components/ui/forms/Switch');
    expect(screen.root.findAllByType(Switch).map(control => control.props.value)).toEqual([false, false]);
    await act(async () => {
      screen.root.findAllByType(Switch)[0]!.props.onValueChange!(true);
    });
    expect(screen.root.findAllByType(Switch)[0]!.props.disabled).toBe(true);
    expect(screen.root.findAllByType(Switch)[0]!.props.value).toBe(false);
    expect(owner.source()).toEqual({
      kind: 'runLifecycle',
      enabled: true,
      source: { kind: 'workflow_run', runId: 'workflow-one' },
      condition: 'terminal',
    });
    expect(
      screen.findByTestId('notify-run-terminal-armed:workflow-one'),
    ).toBeNull();
    await act(async () => {
      owner.acceptCreate();
    });
    expect(screen.root.findAllByType(Switch).map(control => control.props.value)).toEqual([true, false]);
    expect(screen.root.findAllByType(Switch)[0]!.props.disabled).toBe(false);
    expect(
      screen.findByTestId('notify-run-terminal-armed:workflow-one'),
    ).not.toBeNull();
    await act(async () => {
      screen.root.findAllByType(Switch)[0]!.props.onValueChange!(false);
    });
    expect(screen.root.findAllByType(Switch)[0]!.props.disabled).toBe(true);
    expect(screen.root.findAllByType(Switch)[0]!.props.value).toBe(true);
    expect(
      screen.findByTestId('notify-run-terminal-armed:workflow-one'),
    ).not.toBeNull();
    await act(async () => {
      owner.acceptRemove();
    });
    expect(
      screen.findByTestId('notify-run-terminal-armed:workflow-one'),
    ).toBeNull();
    expect(
      [...owner.rows.values()].flatMap((row) => row.triggers),
    ).toHaveLength(0);
    expect(screen.root.findAllByType(Switch)[0]!.props.value).toBe(false);
  });

  it('binds workflow needs-me to its supported predicate but never offers synthesized execution attention', async () => {
    const workflow = ownerFixture();
    workflow.acceptCreate();
    const workflowScreen = await renderScreen(
      <RunWorkNotifyOperation
        source={{ kind: 'workflow_run', runId: 'workflow-one' }}
        project={{ machineId: 'machine-one', directory: '/workspace' }}
        read={workflow.runRead}
        execute={workflow.execute}
      />,
    );
    await act(async () => {
      workflowScreen.pressByTestId('notify-run-needs_attention:workflow-one');
    });
    expect(workflow.source()).toMatchObject({
      source: { kind: 'workflow_run', runId: 'workflow-one' },
      condition: 'needs_attention',
    });
    const execution = ownerFixture();
    const executionScreen = await renderScreen(
      <RunWorkNotifyOperation
        source={{
          kind: 'execution_run',
          machineId: 'machine-one',
          runId: 'execution-one',
        }}
        project={{ machineId: 'machine-one', directory: '/workspace' }}
        read={execution.runRead}
        execute={execution.execute}
      />,
    );
    expect(
      executionScreen.findByTestId('notify-run-needs_attention:execution-one'),
    ).toBeNull();
    expect(
      executionScreen.findByTestId('notify-run-terminal:execution-one'),
    ).not.toBeNull();
  });
});
