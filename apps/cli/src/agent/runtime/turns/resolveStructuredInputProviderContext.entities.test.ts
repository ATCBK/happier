import { expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createWorkflowDefinitionActions } from '@happier-dev/protocol/actions/executor/workflowDefinitions';
import { createWorkflowActionExecutor } from '@happier-dev/protocol/actions/executor/workflowAccountActions';
import { createWidgetAreaActionPortV1, createWidgetSurfaceArtifactPortV1 } from '@happier-dev/protocol/widgets/widgetSurfaceArtifactV1';
import { formatWidgetInstanceRefKeyV1, type WidgetInstanceRefV1 } from '@happier-dev/protocol/widgets';
import { buildMentionRefForKindV1, MENTION_KIND_V1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { formatInlineReferenceTokenV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import { buildUploadedAttachment } from '@happier-dev/protocol/messages/structured/sessionAttachmentsInputV1';
import { createWorkBoardArtifactBoundary } from '../../../../../../packages/protocol/src/boards/workBoardArtifactV1.testkit';
import { prepareSessionInputForProviderDispatch } from './prepareSessionInputForProviderDispatch';
import type { StructuredInputCatalogReaders } from './resolveStructuredInputProviderContext';

it('resolves current entity titles through real Actions and projects folders without entity bodies', async () => {
  const boundary = createWorkBoardArtifactBoundary();
  const transport = boundary.forAccount('account');
  const definitionId = '11111111-1111-4111-8111-111111111111';
  const deletedId = '22222222-2222-4222-8222-222222222222';
  const unused = (): never => { throw new Error('unexpected_operation'); };
  const definitions = createWorkflowDefinitionActions({ artifactStore: { ...transport,
    read: async (id, options) => {
      const row = await transport.read(id, options);
      if (!row) return null;
      if (!row.access) throw new Error('fixture_access_missing');
      return { ...row, access: row.access };
    },
    list: unused, delete: boundary.transport.delete }, encodeListCursor: row => row.artifactId,
    assertDefinitionWriteAllowed: unused });
  await transport.create({ artifactId: definitionId,
    header: { kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Current workflow' } },
    body: JSON.stringify({ kind: 'workflow-definition.v1', definition: { version: 1,
      defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } }, blocks: [{ kind: 'step', id: 'step',
      document: { text: 'PRIVATE WORKFLOW BODY', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] } }) });
  const widget: WidgetInstanceRefV1 = { surface: { serverId: 'home', accountId: 'account', owner: { kind: 'project', projectId: 'project' } }, instanceId: 'copy' };
  const port = createWidgetSurfaceArtifactPortV1(transport, { surface: widget.surface, isCurrent: () => true });
  await port.apply({ kind: 'add', instance: { v: 1, id: widget.instanceId, definition: { kind: 'builtin', id: 'session_summary' },
    displayName: 'Current widget', bindings: { private: { kind: 'value', value: 'PRIVATE WIDGET BODY' } } } });
  const unnamedWidgets: WidgetInstanceRefV1[] = ['summary-1', 'summary-2'].map(instanceId => ({ ...widget, instanceId }));
  for (const unnamed of unnamedWidgets) {
    await port.apply({ kind: 'add', instance: { v: 1, id: unnamed.instanceId,
      definition: { kind: 'builtin', id: 'session_summary' }, bindings: {} } });
  }
  const otherWidget: WidgetInstanceRefV1 = { ...widget, surface: { ...widget.surface,
    owner: { kind: 'project', projectId: 'other-project' } } };
  await createWidgetSurfaceArtifactPortV1(transport, { surface: otherWidget.surface, isCurrent: () => true }).apply({ kind: 'add',
    instance: { v: 1, id: otherWidget.instanceId, definition: { kind: 'builtin', id: 'session_summary' },
      bindings: {} } });
  const area = createWidgetAreaActionPortV1(surface => createWidgetSurfaceArtifactPortV1(transport, { surface, isCurrent: () => true }));
  let catalogUnavailable = false;
  const executor = createActionExecutor({ workflowAction: createWorkflowActionExecutor({ isWorkflowFeatureEnabled: () => true,
    definitions, runs: { execute: unused } }), widgetAccountScope: () => ({ serverId: 'home', accountId: 'account' }),
    widgetSurfaceActions: { project: area },
    widgetCatalog: { list: async surface => {
      if (catalogUnavailable) throw new Error('catalog_offline');
      return [{ definition: { kind: 'builtin', id: 'session_summary' },
        title: surface.owner.kind === 'project' && surface.owner.projectId === 'other-project' ? 'Other summary' : 'Current summary', fields: [],
        availability: 'available', instanceCount: 3, sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' } }];
    } },
    executionRunStart: unused, executionRunList: unused, executionRunGet: unused,
    detachedExecutionRunSend: unused, executionRunStop: unused, executionRunAction: unused, executionRunWait: unused,
    sessionOpen: unused, sessionFork: unused, sessionRollback: unused, sessionSpawnNew: unused,
    resolveAgentStartContext: unused, pathsListRecent: unused, machinesList: unused, serversList: unused,
    reviewEnginesList: unused, agentsBackendsList: unused, agentsModelsList: unused,
    sessionSendMessage: unused, sessionPermissionRespond: unused, sessionUserActionAnswer: unused,
    sessionModeSet: unused, sessionModesList: unused, sessionTargetPrimarySet: unused, sessionTargetTrackedSet: unused,
    sessionList: unused, sessionActivityGet: unused, sessionRecentMessagesGet: unused, resetGlobalVoiceAgent: unused,
    daemonMemorySearch: unused, daemonMemoryGetWindow: unused, daemonMemoryEnsureUpToDate: unused,
  });
  expect(await executor.execute('workflow.definition.get', { definitionId }, { surface: 'cli' })).toMatchObject({ ok: true,
    result: { metadata: { title: 'Current workflow' } } });
  const refs = [{ kind: MENTION_KIND_V1.workflow, opaque: definitionId },
    ...[widget, ...unnamedWidgets, otherWidget].map(ref => ({ kind: MENTION_KIND_V1.widget, opaque: formatWidgetInstanceRefKeyV1(ref) })),
    { kind: MENTION_KIND_V1.workflow, opaque: deletedId }].map(({ kind, opaque }) => {
      const ref = buildMentionRefForKindV1(kind, opaque);
      return { kind, ref, label: 'Old title', token: formatInlineReferenceTokenV1({ label: 'Old title', ref }) };
    });
  const folder = buildUploadedAttachment({ id: 'folder', name: 'source', path: '.happier/uploads/source', mimeType: 'inode/directory', sizeBytes: 23 });
  const text = `Use ${refs.map(ref => ref.token).join(' and ')} and [source](happier-ref:attachment:folder).`;
  let abortDuringRead: { actionId: 'widgets.item.list' | 'widgets.catalog.list'; controller: AbortController } | undefined;
  const readReferenceAction = vi.fn<NonNullable<StructuredInputCatalogReaders['readReferenceAction']>>(async (actionId, input, signal) => {
    const result = await executor.execute(actionId, input, { surface: 'cli', signal });
    if (abortDuringRead?.actionId === actionId) abortDuringRead.controller.abort(new Error('reference_read_cancelled'));
    return result.ok ? result.result : null;
  });
  const catalogs: StructuredInputCatalogReaders = { readReferenceAction };
  const prepare = (signal = new AbortController().signal) => prepareSessionInputForProviderDispatch({
    prompt: { text, localId: 'input', attachments: [folder], structuredInput: { v: 1, mentions: refs } }, transformedUserText: text,
    providerNativeCommand: false, signal, localId: 'input', services: { catalogs } });
  const prepared = await prepare();
  expect(prepared.requiredPrompt).toContain('Use @Workflow "Current workflow" and @Widget "Current widget" and @Widget "Current summary" and @Widget "Current summary" and @Widget "Other summary" and @Workflow "Old title" and [Folder: source].');
  const widgetReads = () => readReferenceAction.mock.calls.filter(([actionId]) => actionId === 'widgets.item.list');
  const catalogReads = () => readReferenceAction.mock.calls.filter(([actionId]) => actionId === 'widgets.catalog.list');
  expect(widgetReads().map(([, input]) => input)).toEqual([{ surface: widget.surface }, { surface: otherWidget.surface }]);
  expect(catalogReads().map(([, input]) => input)).toEqual([{ surface: widget.surface }, { surface: otherWidget.surface }]);
  expect(prepared.requiredPrompt).toContain(`workflow_id="${definitionId}"; label="Current workflow"; read_action="workflow.definition.get"`);
  expect(prepared.requiredPrompt).toContain('read_action="widgets.item.list"');
  expect(prepared.requiredPrompt).toContain(`workflow_id="${deletedId}"; label="Old title"; unavailable`);
  expect(prepared.requiredPrompt).toContain(folder.path);
  expect(prepared.requiredPrompt.match(/<happier_references v="1">/g)).toHaveLength(1);
  expect(prepared.requiredPrompt).not.toMatch(/happier-ref:|PRIVATE WORKFLOW BODY|PRIVATE WIDGET BODY/);
  readReferenceAction.mockClear();
  boundary.offline(true);
  const unavailable = await prepare();
  expect(unavailable.requiredPrompt.match(/; unavailable/g)).toHaveLength(6);
  expect(widgetReads()).toHaveLength(2);
  expect(catalogReads()).toHaveLength(0);
  expect(unavailable.requiredPrompt).toContain('[Folder: source]');
  boundary.offline(false);
  catalogUnavailable = true;
  readReferenceAction.mockClear();
  const withoutCatalog = await prepare();
  expect(withoutCatalog.requiredPrompt).toContain('@Widget "Current widget" and @Widget "Old title" and @Widget "Old title" and @Widget "Old title"');
  expect(withoutCatalog.requiredPrompt.match(/; unavailable/g)).toHaveLength(1);
  expect(catalogReads()).toHaveLength(2);
  catalogUnavailable = false;
  expect((await prepare()).requiredPrompt).toContain('@Widget "Current widget"');
  for (const actionId of ['widgets.item.list', 'widgets.catalog.list'] as const) {
    const controller = new AbortController();
    abortDuringRead = { actionId, controller };
    await expect(prepare(controller.signal)).rejects.toThrow('reference_read_cancelled');
  }
  abortDuringRead = undefined;
  const cancelled = new AbortController();
  cancelled.abort(new Error('reference_read_cancelled'));
  await expect(prepare(cancelled.signal)).rejects.toThrow('reference_read_cancelled');
});
