import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeWorkflowIngress,
  AutomationDefinitionCreateRequestSchema,
  AutomationDefinitionDetailSchema,
  AutomationDefinitionListResponseSchema,
  AutomationDefinitionReconcileRequestSchema,
  AutomationStoredWorkflowDefinitionRecipeV2Schema,
  AutomationStoredWorkflowDefinitionV2Schema,
  type AutomationDefinitionDetail,
  WorkflowTriggerSetV1Schema,
  type WorkflowTriggerSetV1,
} from '@happier-dev/protocol';

import { createMachineFixture, createSessionFixture, flushHookEffects, renderScreen } from '@/dev/testkit';
import { serveSessionActionHome } from '@/dev/testkit/harness/sessionActionHome';
import { installWorkflowActionHttpBoundary } from '@/dev/testkit/fixtures/workflowActionHttpBoundary';
import { activateStorageAccountScope } from '@/dev/testkit/mocks/storage';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { getStorage } from '@/sync/domains/state/storage';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { UniversalSearchRuntimeProvider } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { DEFAULT_MACHINE_ONLINE_GRACE_MS } from '@happier-dev/protocol/machines/machineReachabilityV1';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routeParams = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));
// The route is a boundary: "When this turn finishes…" arrives as deep-link params.
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  const mock = createExpoRouterMock({ params: {} });
  return {
    ...mock.module,
    useLocalSearchParams: () => routeParams.current,
    useGlobalSearchParams: () => routeParams.current,
  };
});

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});

const { SessionWorkViewWithTriggers: WorkView } =
  await import('./SessionWorkViewWithTriggers');

function SessionWorkViewWithTriggers(props: React.ComponentProps<typeof WorkView>) {
  return <InjectedAuthProvider credentials={null}><UniversalSearchRuntimeProvider value={searchRuntime}>
    <AppPaneProvider><WorkView {...props} /></AppPaneProvider>
  </UniversalSearchRuntimeProvider></InjectedAuthProvider>;
}
const searchRuntime = { open: () => {}, buildCommands: () => [] };

const inline = normalizeWorkflowIngress({
  version: 1,
  defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } },
  blocks: ['Summarize overnight CI'],
});
if (inline.kind !== 'parsed')
  throw new Error('fixture definition must normalize');
const definition = inline.definition;

function lifecycleTrigger(id: string, enabled: boolean) {
  return {
    id,
    revision: 1,
    enabled,
    createdAt: 1,
    updatedAt: 1,
    kind: 'sessionLifecycle',
    triggerDefinitionEnvelope: null,
    sourceSessionId: 'session-1',
    events: ['parentTurnCompleted'],
    policy: { kind: 'everyMatch' },
    remainingOccurrences: null,
    status: { state: 'waiting', runId: null },
  };
}

function triggerSet(
  triggers: ReturnType<typeof lifecycleTrigger>[],
): WorkflowTriggerSetV1 {
  return WorkflowTriggerSetV1Schema.parse({
    automationId: 'set-1',
    revision: 4,
    enabled: true,
    health: 'available',
    target: {
      kind: 'inline',
      definition,
    },
    triggers,
  });
}

// HTTP is the boundary. The real Account Action owner opens this canonical
// Automation recipe and projects the trigger sets consumed by the Work host.
let rows: AutomationDefinitionDetail[] = [];
let failAutomationReads = false;
let finishRunRead: (() => Promise<void>) | undefined;
const automationHttp = vi.fn(async (url: URL, init?: RequestInit): Promise<Response> => {
  const method = init?.method ?? 'GET';
  if (method === 'GET' && failAutomationReads) return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
  if (url.pathname === '/v3/automations' && method === 'GET') {
    const scope = url.searchParams.get('scopeSessionId');
    const selected = rows.filter(row => scope ? row.scopeSessionId === scope : row.scopeSessionId === null);
    return Response.json(AutomationDefinitionListResponseSchema.parse({ automations: selected.map(row => {
      const { executionRecipe: _recipe, templateCiphertext: _template, ...summary } = row;
      return { ...summary, triggers: row.triggers.map(({ triggerDefinitionEnvelope: _envelope, ...trigger }) => trigger) };
    }), nextCursor: null }));
  }
  if (url.pathname === '/v3/automations' && method === 'POST') {
    const input = AutomationDefinitionCreateRequestSchema.parse(JSON.parse(String(init?.body)));
    const row = AutomationDefinitionDetailSchema.parse({ id: input.automationId, name: input.name,
      description: input.description ?? null, enabled: input.enabled, workflowDefinitionId: input.workflowDefinitionId ?? null,
      scopeSessionId: input.scopeSessionId ?? null, targetType: null, existingSessionId: null,
      templateVersion: input.executionRecipe.templateVersion, lastRunAt: null, createdAt: 1, updatedAt: 1,
      executionRecipe: input.executionRecipe, assignments: input.assignments?.map(assignment => ({ ...assignment,
        enabled: assignment.enabled ?? true, priority: assignment.priority ?? 0, updatedAt: 1 })) ?? [],
      triggers: input.triggers.map(({ triggerId, trigger }) => ({ ...trigger, id: triggerId, revision: 1,
        enabled: true, createdAt: 1, updatedAt: 1, triggerDefinitionEnvelope: null,
        remainingOccurrences: trigger.kind === 'sessionLifecycle' && trigger.policy.kind === 'currentTurn' ? 1 : null,
        status: { state: 'waiting', runId: null } })),
    });
    rows = [...rows, row];
    return Response.json(row);
  }
  const id = decodeURIComponent(url.pathname.slice('/v3/automations/'.length));
  const row = rows.find(candidate => candidate.id === id);
  if (!row) return Response.json({ error: 'not_found' }, { status: 404 });
  if (method === 'PUT') {
    const input = AutomationDefinitionReconcileRequestSchema.parse(JSON.parse(String(init?.body)));
    const updated = AutomationDefinitionDetailSchema.parse({ ...row, templateVersion: row.templateVersion + 1,
      enabled: input.enabled ?? row.enabled, executionRecipe: input.executionRecipe ?? row.executionRecipe,
      triggers: row.triggers.map(trigger => {
        const patch = input.triggers.find(item => item.kind === 'existing' && item.triggerId === trigger.id);
        return patch?.kind === 'existing' ? { ...trigger, enabled: patch.enabled ?? trigger.enabled } : trigger;
      }),
    });
    rows = rows.map(candidate => candidate.id === id ? updated : candidate);
    return Response.json(updated);
  }
  return Response.json(row);
});

function answer(sets: readonly WorkflowTriggerSetV1[]) {
  failAutomationReads = false;
  rows = sets.map(set => AutomationDefinitionDetailSchema.parse({ id: set.automationId, name: 'Session habit',
    description: null, enabled: set.enabled, workflowDefinitionId: null, scopeSessionId: 'session-1',
    targetType: null, existingSessionId: null, templateVersion: set.revision, lastRunAt: null, createdAt: 1, updatedAt: 1,
    assignments: [{ machineId: 'machine-a', enabled: true, priority: 0, updatedAt: 1 }],
    executionRecipe: AutomationStoredWorkflowDefinitionRecipeV2Schema.parse({ v: 2, templateVersion: set.revision,
      workflow: { t: 'plain', v: AutomationStoredWorkflowDefinitionV2Schema.parse({ workspace: { directory: '/repo' },
        executionTarget: { kind: 'session' }, inlineDefinition: definition }) }, triggerEvidence: null }), triggers: set.triggers,
  }));
}

async function settle() {
  await flushHookEffects();
}

let accountScope: Awaited<ReturnType<typeof activateStorageAccountScope>>;
let home: Awaited<ReturnType<typeof serveSessionActionHome>>;
let workflowHttp: Awaited<ReturnType<typeof installWorkflowActionHttpBoundary>>;
let previousState = getStorage().getState();
let restorePresenceClock: (() => void) | undefined;
function resetTriggerSets() {
  const state = getStorage().getState();
  if (!('resetWorkflowTriggerSets' in state) || typeof state.resetWorkflowTriggerSets !== 'function') {
    throw new Error('The real Automation store must provide resetWorkflowTriggerSets');
  }
  state.resetWorkflowTriggerSets();
}
beforeEach(async () => {
  previousState = getStorage().getState();
  home = await serveSessionActionHome({ homes: [{ key: 'session', serverUrl: 'https://server-a', accountId: 'account-a', currentAccount: true }],
    route: request => request.path === '/v1/artifacts' ? Response.json([]) : undefined });
  accountScope = await activateStorageAccountScope({ serverId: home.serverId, accountId: 'account-a' });
  resetTriggerSets();
  rows = [];
  failAutomationReads = false;
  finishRunRead = undefined;
  automationHttp.mockClear();
  workflowHttp = await installWorkflowActionHttpBoundary({ automationDefinitions: automationHttp,
    fixtureResponse: async actionId => {
      if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions: [], nextCursor: null } };
      if (actionId === 'workflow.run.list') {
        await finishRunRead?.();
        return { ok: true, result: { runs: [], metadataByRunId: {} } };
      }
      throw new Error(`Unexpected fixture Action ${actionId}`);
    } });
  workflowHttp.prime();
  seedSessionMachine(true);
});
afterEach(async () => {
  await standardCleanup();
  resetTriggerSets();
  workflowHttp?.dispose();
  act(() => accountScope.dispose());
  await home.dispose();
  getStorage().setState(previousState, true);
  routeParams.current = {};
  restorePresenceClock?.();
  restorePresenceClock = undefined;
});

function seedSessionMachine(machineActive: boolean) {
  const previous = getStorage().getState().machines['machine-a'];
  const observedAt = Math.max(Date.now(), (previous?.activeAt ?? 0) + 1);
  const machine = createMachineFixture({ id: 'machine-a', active: machineActive, activeAt: observedAt, updatedAt: observedAt });
  const session = createSessionFixture({ id: 'session-1', serverId: home.serverId, active: true,
    metadata: { machineId: 'machine-a', path: '/repo', host: machine.metadata!.host } });
  act(() => {
    getStorage().getState().applyMachines([machine]);
    getStorage().getState().applySessions([session]);
  });
  if (!machineActive) {
    // A recent heartbeat remains online through the shared daemon-presence grace.
    // Advance only the clock boundary, then let real presence selectors expire it.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(observedAt + DEFAULT_MACHINE_ONLINE_GRACE_MS + 1);
    restorePresenceClock = () => clock.mockRestore();
  }
  return machine;
}

describe('the Work tab Triggers section', () => {
  it('keeps ordinary rows usable and shows a separate PR-link retry state', async () => {
    // No Channels Data collection is installed for this Account, so the real
    // PR-link reader refuses independently of the readable Automation rows.
    answer([triggerSet([lifecycleTrigger('trig-1', true)])]);
    const screen = await renderScreen(
      <SessionWorkViewWithTriggers sessionId="session-1" scopeId="scope-1" />,
    );
    await settle();
    expect(
      screen.findByTestId('session-work-trigger:set-1:trig-1-switch')?.props
        .value,
    ).toBe(true);
    expect(screen.findByTestId('session-work-triggers-failed')).toBeNull();
    expect(
      screen.findByTestId('session-work-trigger-links-unavailable'),
    ).not.toBeNull();
  });
  it('turns one trigger on or off through session.trigger.update, never by pausing its Automation', async () => {
    // trig-1 is off at trigger level inside an enabled set; trig-2 shares the set.
    answer([
      triggerSet([
        lifecycleTrigger('trig-1', false),
        lifecycleTrigger('trig-2', true),
      ]),
    ]);
    const screen = await renderScreen(
      <SessionWorkViewWithTriggers sessionId="session-1" scopeId="scope-1" />,
    );
    await settle();

    // The real Session resolver chooses its placement. Account HTTP owns the
    // trigger rows; its list must keep the Session filter and Account token.
    expect(automationHttp.mock.calls.some(([url, init]) => url.searchParams.get('scopeSessionId') === 'session-1'
      && new Headers(init?.headers).get('Authorization')?.startsWith('Bearer '))).toBe(true);
    const offSwitch = screen.findByTestId(
      'session-work-trigger:set-1:trig-1-switch',
    );
    const automationsBefore = getStorage().getState().automations;
    expect(offSwitch?.props.value).toBe(false);
    await act(async () => {
      offSwitch?.props.onValueChange(true);
    });
    await settle();

    await vi.waitFor(() => expect(automationHttp.mock.calls.map(([url, init]) => ({ path: url.pathname, method: init?.method ?? 'GET' })))
      .toContainEqual({ path: '/v3/automations/set-1', method: 'PUT' }));
    await vi.waitFor(() => expect(screen.findByTestId('session-work-trigger:set-1:trig-1-switch')?.props.value).toBe(true));
    const mutation = automationHttp.mock.calls.find(([url, init]) => url.pathname === '/v3/automations/set-1' && init?.method === 'PUT');
    expect(mutation).toBeDefined();
    expect(AutomationDefinitionReconcileRequestSchema.parse(JSON.parse(String(mutation?.[1]?.body)))).toMatchObject({
      expectedTemplateVersion: 4,
      triggers: [{ kind: 'existing', triggerId: 'trig-1', expectedRevision: 1, enabled: true },
        { kind: 'existing', triggerId: 'trig-2', expectedRevision: 1 }],
    });
    expect(rows[0]?.assignments).toEqual([{ machineId: 'machine-a', enabled: true, priority: 0, updatedAt: 1 }]);
    expect(rows[0]?.enabled).toBe(true);
    expect(screen.findByTestId('session-work-trigger:set-1:trig-1-switch')?.props.value).toBe(true);
    expect(getStorage().getState().automations).toBe(automationsBefore);
    expect(screen.findByTestId('session-work-trigger:set-1:trig-2-switch')?.props.value).toBe(true);
  });

  it('stays in the Work tab with its empty state and a way to add the first trigger', async () => {
    answer([]);
    const screen = await renderScreen(
      <SessionWorkViewWithTriggers sessionId="session-1" scopeId="scope-1" />,
    );
    await settle();

    expect(screen.findByTestId('session-work-triggers')).not.toBeNull();
    expect(screen.findByTestId('session-work-triggers-empty')).not.toBeNull();
    expect(screen.findByTestId('session-work-triggers-add')).not.toBeNull();
  });

  it('draws no "Writes here" heading while nothing writes into this session, loading or loaded', async () => {
    const { resetWorkflowLibraryReadsForTests } = await import(
      '@/components/workflows/library/workflowLibraryReads'
    );
    resetWorkflowLibraryReadsForTests();
    const runList: { finish: (() => void) | null } = { finish: null };
    answer([]);
    finishRunRead = () => new Promise<void>((resolve) => { runList.finish = resolve; });
    const screen = await renderScreen(
      <SessionWorkViewWithTriggers sessionId="session-1" scopeId="scope-1" />,
    );
    await settle();
    // Still reading: a section that may not exist holds no skeleton that later collapses.
    expect(screen.findByTestId('session-work-writes-here')).toBeNull();

    await act(async () => {
      runList.finish?.();
    });
    await settle();
    expect(screen.findByTestId('session-work-writes-here')).toBeNull();
  });

  it('opens "When this turn finishes…" bound to that turn and adds it through session.trigger.add', async () => {
    answer([]);
    routeParams.current = {
      sourceSessionId: 'session-1',
      sourceTurnId: 'turn-7',
      sourceServerId: home.serverId,
      sessionLifecycleEvents: 'parentTurnCompleted',
    };
    const screen = await renderScreen(
      <SessionWorkViewWithTriggers sessionId="session-1" scopeId="scope-1" />,
    );
    await settle();

    expect(screen.findByTestId('session-work-trigger-popover')).not.toBeNull();
    await act(async () => {
      screen.changeTextByTestId(
        'session-work-trigger-popover-prompt',
        'Review what changed',
      );
    });
    await act(async () => {
      screen.pressByTestId('session-work-trigger-popover-submit');
    });
    await settle();

    const add = automationHttp.mock.calls.find(([url, init]) => url.pathname === '/v3/automations' && init?.method === 'POST');
    expect(add).toBeDefined();
    const created = AutomationDefinitionCreateRequestSchema.parse(JSON.parse(String(add?.[1]?.body)));
    expect(created).toMatchObject({
      scopeSessionId: 'session-1',
      assignments: [{ machineId: 'machine-a' }],
      triggers: [{ trigger: {
        kind: 'sessionLifecycle',
        sourceSessionId: 'session-1',
        policy: { kind: 'currentTurn', sourceTurnId: 'turn-7' },
      } }],
      executionRecipe: { v: 2, workflow: { t: 'plain', v: { inlineDefinition: {
        blocks: [{ document: { text: 'Review what changed' } }],
      } } } },
    });
    expect(getStorage().getState().workflowTriggerSetsById[created.automationId]?.target?.kind).toBe('inline');
  });
  describe('when the session Machine is offline', () => {
    function failReads() {
      failAutomationReads = true;
    }

    it('leaves the unreachable Machine to the Work view\'s own offline line instead of saying the read failed again', async () => {
      seedSessionMachine(false);
      failReads();
      const screen = await renderScreen(<SessionWorkViewWithTriggers sessionId="session-1" scopeId="scope-1" />);
      await settle();
      expect(screen.findByTestId('session-work-triggers-failed')).toBeNull();
    });

    it('still says a failed read when the Machine is reachable', async () => {
      seedSessionMachine(true);
      failReads();
      const screen = await renderScreen(<SessionWorkViewWithTriggers sessionId="session-1" scopeId="scope-1" />);
      await settle();
      expect(screen.findByTestId('session-work-triggers-failed')).not.toBeNull();
    });

    it('reads again by itself when the offline Machine returns', async () => {
      const offline = seedSessionMachine(false);
      failReads();
      const screen = await renderScreen(<SessionWorkViewWithTriggers sessionId="session-1" scopeId="scope-1" />);
      await settle();
      expect(screen.findByTestId('session-work-trigger:set-1:trig-1-switch')).toBeNull();
      answer([triggerSet([lifecycleTrigger('trig-1', true)])]);
      const observedAt = Math.max(Date.now(), offline.activeAt + 1);
      const online = { ...offline, active: true, activeAt: observedAt, updatedAt: observedAt };
      await act(async () => getStorage().getState().applyMachines([online]));
      await settle();
      expect(screen.findByTestId('session-work-trigger:set-1:trig-1-switch')).not.toBeNull();
    });
  });

});
