import {
  AutomationStoredWorkflowDefinitionRecipeV2Schema,
  AutomationTriggerIdSchema,
  createActionExecutor,
  createWorkflowTriggerActions,
  type ActionExecutorDeps,
  type AutomationDefinitionDetail,
  type WorkflowTriggerActionsDependencies,
} from '@happier-dev/protocol';
import { WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { SessionTriggersRead } from '@/components/workflows/triggers/useSessionTriggers';
import { ExecutionRunGetResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { ScmDiffSummaryGenerateOutputSchema } from '@happier-dev/protocol/scm/diffSummary';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';

export function createWorkNotificationOwnerFixture(
  options: Readonly<{
    notificationChannelsList?: ActionExecutorDeps['notificationChannelsList'];
    disconnected?: boolean;
    configured?: boolean;
    channelDisconnected?: boolean;
    runOutputState?: 'pending' | 'writing' | 'complete' | 'failed';
  }> = {},
): {
  read: SessionTriggersRead;
  runRead: {
    status: 'ready';
    sets: never[];
    add: ReturnType<typeof createWorkflowTriggerActions>['add'];
    remove: (automationId: string, triggerId: string) => Promise<ReturnType<typeof WorkflowTriggerWriteResultV1Schema.parse>>;
  };
  execute: ReturnType<typeof createFrontDoorActionExecute>;
  acceptCreate: () => void;
  acceptRemove: () => void;
  rows: Map<string, AutomationDefinitionDetail>;
  actions: ReturnType<typeof createWorkflowTriggerActions>;
  source: () => unknown;
  removedId: () => string | undefined;
} {
  const rows = new Map<string, AutomationDefinitionDetail>();
  let id = 0;
  let acceptCreate: () => void = () => undefined;
  let acceptRemove: () => void = () => undefined;
  let source: unknown;
  let removedId: string | undefined;
  const createReady = new Promise<void>((resolve) => {
    acceptCreate = resolve;
  });
  const removeReady = new Promise<void>((resolve) => {
    acceptRemove = resolve;
  });
  const deps: WorkflowTriggerActionsDependencies = {
    newId: (kind) => `${kind}-${++id}`,
    resolveSession: async () => ({
      project: { machineId: 'machine-one', directory: '/workspace' },
      nativeGoalOwner: false,
    }),
    resolveWorkflow: async () => {
      throw new Error('Unexpected workflow read');
    },
    resolveRunSource: async () => ({ terminal: false }),
    // The authenticated Session, content codec and durable Automation operations are
    // the external boundaries. Real Action validation/projection/admission stays below the view.
    openContext: async (row) =>
      row.executionRecipe?.v === 2 && row.executionRecipe.workflow.t === 'plain'
        ? row.executionRecipe.workflow.v
        : null,
    sealContext: async ({ templateVersion, context }) =>
      AutomationStoredWorkflowDefinitionRecipeV2Schema.parse({
        v: 2,
        templateVersion,
        workflow: { t: 'plain', v: context },
        triggerEvidence: null,
      }),
    automations: {
      list: async () => ({
        automations: [...rows.values()].map(
          ({ executionRecipe: _private, ...row }) => row,
        ),
        nextCursor: null,
      }),
      get: async (automationId) => rows.get(automationId) ?? null,
      create: async (input) => {
        if (options.disconnected) throw new Error('disconnected');
        source = input.triggers[0]?.trigger;
        await createReady;
        const row: AutomationDefinitionDetail = {
          id: input.automationId,
          name: input.name,
          description: null,
          enabled: input.enabled,
          targetType: null,
          existingSessionId: null,
          templateVersion: 1,
          lastRunAt: null,
          createdAt: 1,
          updatedAt: 1,
          workflowDefinitionId: input.workflowDefinitionId,
          scopeSessionId: input.scopeSessionId,
          executionRecipe: input.executionRecipe,
          assignments: [
            {
              machineId: 'machine-one',
              enabled: true,
              priority: 0,
              updatedAt: 1,
            },
          ],
          triggers: input.triggers.map((item) => {
            if (
              item.trigger.kind !== 'sessionLifecycle' &&
              item.trigger.kind !== 'runLifecycle'
            )
              throw new Error('Unexpected trigger kind');
            return {
              ...item.trigger,
              id: item.triggerId,
              revision: 0,
              createdAt: 1,
              updatedAt: 1,
              remainingOccurrences: 1,
              status: { state: 'waiting', runId: null },
              triggerDefinitionEnvelope: null,
            };
          }),
        };
        rows.set(row.id, row);
        return row;
      },
      reconcile: async (automationId, input) => {
        const row = rows.get(automationId)!;
        removedId = row.triggers.find(
          (trigger) =>
            !input.triggers.some((item) => item.triggerId === trigger.id),
        )?.id;
        await removeReady;
        const committed = {
          ...row,
          triggers: row.triggers.filter((trigger) =>
            input.triggers.some((item) => item.triggerId === trigger.id),
          ),
        };
        rows.set(row.id, committed);
        return committed;
      },
      delete: async () => {
        throw new Error('Unexpected deletion');
      },
    },
  };
  const actions = createWorkflowTriggerActions(deps);
  const read: SessionTriggersRead = {
    status: 'ready',
    sets: [],
    pullRequestLinks: [],
    machineId: 'machine-one',
    lastRunAtByAutomationId: {},
    retry: () => undefined,
    add: (request) =>
      actions.sessionAdd({ ...request, sessionId: 'session-one' }),
    remove: (triggerId) =>
      actions.sessionRemove({
        sessionId: 'session-one',
        triggerId: AutomationTriggerIdSchema.parse(triggerId),
      }),
    update: (request) =>
      actions.sessionUpdate({ ...request, sessionId: 'session-one' }),
  };
  const executor = createActionExecutor(createActionExecutorBoundaryFixture({
    executionRunCheckProtocolV2: async () => ({ ok: true }),
    // The exact Run snapshot comes from the Machine RPC boundary; the registration
    // producer and Action's scope/request/output validation remain real.
    executionRunGet: async (_sessionId: string | null, request: Readonly<{ runId: string; includeStructured?: boolean }>) => {
      if (!options.runOutputState) throw new Error('Unexpected Run read');
      const output = ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey: 'comparison-one',
        resultId: 'saved-one', revision: 4, metadata: { source: { kind: 'workingTree' }, sourceKey: 'comparison-one' },
        comparison: { id: 'comparison-one', source: { kind: 'workingTree' }, repository: { rootPath: '/workspace' },
          endpoints: { before: 'a', after: 'b' }, inventory: { state: 'complete', reasons: [], files: [] } },
        requestedOutputs: ['commitPlan'], outputs: { commitPlan: options.runOutputState === 'complete'
          ? { state: 'complete', value: { groups: [], leftOutChangeRefs: [] } } : { state: options.runOutputState } },
        analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
      });
      return ExecutionRunGetResponseSchema.parse({ run: { runId: request.runId, callId: 'call', sidechainId: 'sidechain',
        intent: 'scm_diff_summary', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        permissionMode: 'read-only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
        startedAtMs: 1, status: 'running' },
        ...(request.includeStructured ? { structuredMeta: { kind: 'scm_diff_summary.v1', payload: output } } : {}),
      });
    },
    // The Account daemon's channel catalog is a genuine remote boundary.
    notificationChannelsList: options.notificationChannelsList ?? (async () => {
      if (options.channelDisconnected)
        return {
          ok: false,
          errorCode: 'target_unavailable',
          error: 'target_unavailable',
        };
      return {
        items: [
          {
            value: 'plugin/digest',
            label: 'Digest',
            disabled: options.configured === false,
          },
        ],
      };
    }),
  }));
  const runRead = {
    status: 'ready' as const,
    sets: [],
    add: actions.add,
    remove: async (automationId: string, triggerId: string) =>
      WorkflowTriggerWriteResultV1Schema.parse(await actions.remove({
        automationId,
        triggerId: AutomationTriggerIdSchema.parse(triggerId),
      })),
  };
  return {
    read,
    runRead,
    execute: createFrontDoorActionExecute(executor),
    acceptCreate,
    acceptRemove,
    rows,
    actions,
    source: () => source,
    removedId: () => removedId,
  };
}

