import {
  TriageSourceDescriptorV1Schema, TriageSourcesContributionProtocolV1, TriageSourceAdministrationActionResultV1Schema,
  TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1,
} from '@happier-dev/triage-protocol/v1';
import { defineProtocolLiteral, defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { TRIAGE_ACCOUNT_ACTION_EXECUTION_V1 } from '../accountExecution.js';
import {
  INTERNAL_TASK_DRAFT_V1, INTERNAL_TASK_SOURCE_V1, INTERNAL_TASK_STATES_V1, internalTaskStateV1,
  scanInternalTasks, getInternalTask, createInternalTask, editInternalTask, transitionInternalTask,
  linkInternalTaskSession, readInternalTaskSessionLinks,
} from './source.js';

const protocol = TriageSourcesContributionProtocolV1;
const fields = ['title', 'body', 'assigneeIds', 'labelIds', 'dueDate', 'parent', 'blockedBy'] as const;
export const INTERNAL_TASK_DESCRIPTOR_V1 = TriageSourceDescriptorV1Schema.parse({
  v: 1, purpose: 'tasks', displayName: 'Happier tasks', settingsPageId: 'internal-tasks',
  kinds: [{ id: 'task', workflowSubject: 'issue', displayName: 'Task', pluralDisplayName: 'Tasks', task: true,
    taskCapabilities: { completedScan: true, createFields: fields, editFields: fields, completingTransitionId: 'completed',
      transitions: INTERNAL_TASK_STATES_V1.map(id => ({ id, label: internalTaskStateV1(id).nativeLabel, state: internalTaskStateV1(id) })) } }],
});
const surfaces = ['plugin', 'ui', 'agent', 'mcp', 'cli'] as const;
const write = { surfaces, placementBindings: [], execution: TRIAGE_ACCOUNT_ACTION_EXECUTION_V1, dangerLevel: 'writesRemote' } as const;
const read = { surfaces, placementBindings: [], execution: TRIAGE_ACCOUNT_ACTION_EXECUTION_V1, dangerLevel: 'safe' } as const;

/** Explicit user intent configures the built-in source through the same writer as every plugin. */
export const INTERNAL_TASK_ACTIONS_V1 = {
  'internal/tasks/configure-v1': {
    ...write, title: 'Use Happier tasks',
    confirmation: { title: 'Use Happier tasks?', body: 'Shows personal tasks from this Happier Account in Tasks.', confirmLabel: 'Use tasks' },
    inputSchema: defineProtocolObject({ v: defineProtocolLiteral(1) }, { policy: 'closed' }),
    resultSchema: TriageSourceAdministrationActionResultV1Schema,
    run: async (_input: Readonly<{ v: 1 }>, context: PluginAccountActionContext) => TriageSourceAdministrationActionResultV1Schema.parse(
      await context.services.actions.execute(TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1, { v: 1, kind: 'create', source: INTERNAL_TASK_SOURCE_V1, draft: INTERNAL_TASK_DRAFT_V1 }, { signal: context.signal })),
  },
  'internal/tasks/list-instances-v1': {
    ...read, title: 'Discover Happier tasks', inputSchema: protocol.operations.listInstances.declaration.input.schema,
    resultSchema: protocol.operations.listInstances.declaration.resultSchema,
    run: async () => ({ kind: 'complete' as const, candidates: [INTERNAL_TASK_DRAFT_V1], failures: [] }),
  },
  'internal/tasks/scan-v1': { ...read, title: 'Read Happier tasks', inputSchema: protocol.operations.scan.declaration.input.schema,
    resultSchema: protocol.operations.scan.declaration.resultSchema, run: scanInternalTasks },
  'internal/tasks/get-v1': { ...read, title: 'Read a Happier task', inputSchema: protocol.operations.get.declaration.input.schema,
    resultSchema: protocol.operations.get.declaration.resultSchema, run: getInternalTask },
  'internal/tasks/create-v1': { ...write, title: 'Create a Happier task',
    confirmation: { title: 'Create this task?', body: 'Creates a personal task in this Happier Account.', confirmLabel: 'Create task' },
    inputSchema: protocol.operations.create.declaration.input.schema, resultSchema: protocol.operations.create.declaration.resultSchema, run: createInternalTask },
  'internal/tasks/edit-v1': { ...write, title: 'Edit a Happier task',
    confirmation: { title: 'Save these task changes?', body: 'Updates the personal task in this Happier Account.', confirmLabel: 'Save changes' },
    inputSchema: protocol.operations.edit.declaration.input.schema, resultSchema: protocol.operations.edit.declaration.resultSchema, run: editInternalTask },
  'internal/tasks/transition-v1': { ...write, title: 'Change a Happier task’s status',
    confirmation: { title: 'Change this task’s status?', body: 'Updates the personal task in this Happier Account.', confirmLabel: 'Change status' },
    inputSchema: protocol.operations.transition.declaration.input.schema, resultSchema: protocol.operations.transition.declaration.resultSchema, run: transitionInternalTask },
  'internal/tasks/link-session-v1': { ...write, title: 'Link or unlink a Happier task',
    confirmation: { title: 'Change this task’s Session link?', body: 'Updates the work linked to this personal task.', confirmLabel: 'Change link' },
    inputSchema: protocol.operations.linkSession.declaration.input.schema, resultSchema: protocol.operations.linkSession.declaration.resultSchema, run: linkInternalTaskSession },
  'internal/tasks/read-session-links-v1': { ...read, title: 'Read Happier task work',
    inputSchema: protocol.operations.readSessionLinks.declaration.input.schema, resultSchema: protocol.operations.readSessionLinks.declaration.resultSchema, run: readInternalTaskSessionLinks },
};

export const INTERNAL_TASK_CONTRIBUTION_V1 = protocol.contribute({ descriptor: INTERNAL_TASK_DESCRIPTOR_V1,
  operations: {
    listInstances: protocol.operations.listInstances.bind('internal/tasks/list-instances-v1'),
    scan: protocol.operations.scan.bind('internal/tasks/scan-v1'), get: protocol.operations.get.bind('internal/tasks/get-v1'),
    create: protocol.operations.create.bind('internal/tasks/create-v1'), edit: protocol.operations.edit.bind('internal/tasks/edit-v1'),
    transition: protocol.operations.transition.bind('internal/tasks/transition-v1'),
    linkSession: protocol.operations.linkSession.bind('internal/tasks/link-session-v1'),
    readSessionLinks: protocol.operations.readSessionLinks.bind('internal/tasks/read-session-links-v1'),
  }, surfaces: { detail: { renderer: 'internal-task-detail' } },
});
