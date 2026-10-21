import { expect, it } from 'vitest';
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
    list: boundary.transport.list, delete: boundary.transport.delete }, encodeListCursor: row => row.artifactId,
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
  const area = createWidgetAreaActionPortV1(surface => createWidgetSurfaceArtifactPortV1(transport, { surface, isCurrent: () => true }));
  const executor = createActionExecutor({ workflowAction: createWorkflowActionExecutor({ isWorkflowFeatureEnabled: () => true,
    definitions, runs: { execute: unused } }), widgetAccountScope: () => ({ serverId: 'home', accountId: 'account' }),
    widgetSurfaceActions: { project: area } });
  expect(await executor.execute('workflow.definition.get', { definitionId }, { surface: 'cli' })).toMatchObject({ ok: true,
    result: { metadata: { title: 'Current workflow' } } });
  const refs = [{ kind: MENTION_KIND_V1.workflow, opaque: definitionId }, { kind: MENTION_KIND_V1.widget, opaque: formatWidgetInstanceRefKeyV1(widget) },
    { kind: MENTION_KIND_V1.workflow, opaque: deletedId }].map(({ kind, opaque }) => {
      const ref = buildMentionRefForKindV1(kind, opaque);
      return { kind, ref, label: 'Old title', token: formatInlineReferenceTokenV1({ label: 'Old title', ref }) };
    });
  const folder = buildUploadedAttachment({ id: 'folder', name: 'source', path: '.happier/uploads/source', mimeType: 'inode/directory', sizeBytes: 23 });
  const text = `Use ${refs.map(ref => ref.token).join(' and ')} and [source](happier-ref:attachment:folder).`;
  const catalogs: StructuredInputCatalogReaders = { readReferenceAction: async (actionId, input, signal) => {
      const result = await executor.execute(actionId, input, { surface: 'cli', signal });
      return result.ok ? result.result : null;
  } };
  const prepare = (signal = new AbortController().signal) => prepareSessionInputForProviderDispatch({
    prompt: { text, attachments: [folder], structuredInput: { v: 1, mentions: refs } }, transformedUserText: text,
    providerNativeCommand: false, signal, localId: 'input', services: { catalogs } });
  const prepared = await prepare();
  expect(prepared.requiredPrompt).toContain('Use @Workflow "Current workflow" and @Widget "Current widget" and @Workflow "Old title" and [Folder: source].');
  expect(prepared.requiredPrompt).toContain(`workflow_id="${definitionId}"; label="Current workflow"; read_action="workflow.definition.get"`);
  expect(prepared.requiredPrompt).toContain('read_action="widgets.item.list"');
  expect(prepared.requiredPrompt).toContain(`workflow_id="${deletedId}"; label="Old title"; unavailable`);
  expect(prepared.requiredPrompt).toContain(folder.path);
  expect(prepared.requiredPrompt.match(/<happier_references v="1">/g)).toHaveLength(1);
  expect(prepared.requiredPrompt).not.toMatch(/happier-ref:|PRIVATE WORKFLOW BODY|PRIVATE WIDGET BODY/);
  boundary.offline(true);
  const unavailable = await prepare();
  expect(unavailable.requiredPrompt.match(/; unavailable/g)).toHaveLength(3);
  expect(unavailable.requiredPrompt).toContain('[Folder: source]');
  boundary.offline(false);
  expect((await prepare()).requiredPrompt).toContain('@Widget "Current widget"');
  const cancelled = new AbortController();
  cancelled.abort(new Error('reference_read_cancelled'));
  await expect(prepare(cancelled.signal)).rejects.toThrow('reference_read_cancelled');
});
