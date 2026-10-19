import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '../actionExecutor.js';
import { createWorkflowActionExecutor, normalizeWorkflowActionThrownError, type WorkflowActionFailureDiagnosticV1 } from './workflowAccountActions.js';
import { createWorkflowDefinitionActions } from './workflowDefinitions.js';
import { createWorkflowAccountRunActionOwner } from './workflowRunActions.js';
import { parseWorkflowDocumentJsonIngressV1 } from '../../workflows/workflowDocumentV1.js';
import { WorkflowActionFailureV1Schema } from '../../workflows/workflowProgressV1.js';

const definitionId = '11111111-1111-4111-8111-111111111111';
const definition = { version: 1 as const, inputs: [], defaults: {}, blocks: [{ kind: 'wait' as const, id: 'wait',
  document: { text: 'Continue', references: [], attachments: [] } }] };

function executor(invalidStoredHeader = false, readFailure?: unknown) {
  const unexpected = (): never => { throw new Error('unexpected_effect'); };
  // Artifact and Run persistence are the only boundaries; all family, reader,
  // validation and admission logic stays real.
  const definitions = createWorkflowDefinitionActions({ encodeListCursor: unexpected,
    assertDefinitionWriteAllowed: unexpected, artifactStore: {
    read: async () => {
      if (readFailure !== undefined) throw readFailure;
      return { artifactId: definitionId, ownerAccountId: 'account', access: 'owner',
      revision: { headerVersion: 1, bodyVersion: 1 },
      header: { kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 1, bodyVersion: 1 },
        metadata: { title: invalidStoredHeader ? 7 : 'Saved Wait' } },
      body: JSON.stringify({ kind: 'workflow-definition.v1', definition }) };
    },
    list: unexpected, create: unexpected, update: unexpected, delete: unexpected,
  } });
  const runs = createWorkflowAccountRunActionOwner({ definitions, storage: { execute: unexpected },
    resolveAccountId: async () => 'account', resolveEncryption: async () => ({ kind: 'available',
      witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
    normalizeAbsolutePath: unexpected, randomBytes: unexpected });
  return createWorkflowActionExecutor({ isWorkflowFeatureEnabled: () => true, definitions, runs });
}

describe('workflow Action refusal classification', () => {
  it('retains a closed HTTP refusal through the family and outer Action boundary', async () => {
    const details = { status: 400, code: 'FST_ERR_VALIDATION' };
    const error = Object.assign(new Error('Workflow request failed (HTTP 400; FST_ERR_VALIDATION)'), {
      code: 'workflow_http_error', details,
    });
    const actions = createActionExecutor({ workflowAction: executor(false, error) } as unknown as ActionExecutorDeps);
    await expect(actions.execute('workflow.definition.get', { definitionId }, { surface: 'api' }))
      .resolves.toEqual({ ok: false, errorCode: 'workflow_http_error', error: error.message, details });
  });
  it('keeps typed target diagnostics through the family and outer Action failure boundary', async () => {
    const details = { code: 'target_unavailable' as const, reason: 'agent_probe_failed' as const,
      agentId: 'claude', errorCode: 'cli-detection-failed', blockId: 'writer' };
    const actions = createActionExecutor({ workflowAction: executor(false,
      Object.assign(new Error('target_unavailable'), { code: 'target_unavailable', details })) } as unknown as ActionExecutorDeps);
    await expect(actions.execute('workflow.definition.get', { definitionId }, { surface: 'ui' }))
      .resolves.toEqual({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable', details });
    expect(normalizeWorkflowActionThrownError(Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' })))
      .toMatchObject({ errorCode: 'target_unavailable', details: { code: 'target_unavailable', reason: 'selection_unavailable' } });
  });
  it('imports a document through the Action seam as unsaved content without persistence or execution', async () => {
    const actions = createActionExecutor({ workflowAction: executor() } as unknown as ActionExecutorDeps);
    const json = JSON.stringify({ kind: 'happier.workflow', version: 1, definition });
    await expect(actions.execute('workflow.definition.import', { json }, { surface: 'mcp' }))
      .resolves.toEqual({ ok: true, result: { ...parseWorkflowDocumentJsonIngressV1(json), classification: 'unsaved_definition' } });
    await expect(actions.execute('workflow.definition.import', { json: '{' }, { surface: 'mcp' }))
      .resolves.toEqual({ ok: true, result: { ok: false, code: 'workflow_document_invalid_json', issues: [] } });
    await expect(actions.execute('workflow.definition.import', { json: JSON.stringify({ kind: 'happier.workflow', version: 2, definition }) }, { surface: 'mcp' }))
      .resolves.toMatchObject({ ok: true, result: { ok: false, code: 'workflow_document_unsupported_version' } });
  });

  it('exports the saved definition through its authorized Artifact reader as canonical portable JSON', async () => {
    const actions = createActionExecutor({ workflowAction: executor() } as unknown as ActionExecutorDeps);
    const result = await actions.execute('workflow.definition.export', { definitionId }, { surface: 'mcp' });
    expect(result).toMatchObject({ ok: true, result: { definitionId, revision: { headerVersion: 1, bodyVersion: 1 },
      document: { kind: 'happier.workflow', version: 1, definition }, json: expect.any(String) } });
    if (!result.ok || !result.result || typeof result.result !== 'object' || !('json' in result.result)) throw new Error('missing_export');
    expect(JSON.parse(String(result.result.json))).toEqual({ kind: 'happier.workflow', version: 1, definition });
    await expect(createActionExecutor({ workflowAction: executor(true) } as unknown as ActionExecutorDeps)
      .execute('workflow.definition.export', { definitionId }, { surface: 'mcp' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable' });
  });
  it.each([
    ['uncoded server failure', new Error('Failed to fetch artifact'), 'storage_unavailable'],
    ['unknown transport code', Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' }), 'storage_unavailable'],
    ['unknown server code', Object.assign(new Error('Transaction acquisition unavailable'), { code: 'P2028' }), 'storage_unavailable'],
    ['typed storage refusal', Object.assign(new Error('Storage unavailable'), { code: 'storage_unavailable' }), 'storage_unavailable'],
    ['unreadable Account role overrides', Object.assign(new Error('account_role_overrides_unavailable'), { code: 'account_role_overrides_unavailable' }), 'content_unavailable'],
    ['typed unopened content refusal', Object.assign(new Error('Artifact content is unavailable'), { code: 'content_unavailable' }), 'content_unavailable'],
    ['retained Session custody missing', Object.assign(new Error('session_key_required'), { code: 'session_key_required' }), 'content_unavailable'],
    ['template encryption material missing', Object.assign(new Error('encryption_material_unavailable'), { code: 'encryption_material_unavailable' }), 'content_unavailable'],
    ['template envelope mode mismatch', Object.assign(new Error('encryption_mode_mismatch'), { code: 'encryption_mode_mismatch' }), 'content_unavailable'],
    ['template decryption failed', Object.assign(new Error('invalid_template'), { code: 'invalid_template' }), 'content_unavailable'],
  ])('classifies %s through the Workflow Action boundary', async (_case, error, errorCode) => {
    const actions = createActionExecutor({ workflowAction: executor(false, error) } as unknown as ActionExecutorDeps);
    await expect(actions.execute('workflow.definition.get', { definitionId }, { surface: 'ui' }))
      .resolves.toMatchObject({ ok: false, errorCode });
  });

  it('preserves the Account role preparation cause in the content-free diagnostic', () => {
    const events: WorkflowActionFailureDiagnosticV1[] = [];
    const result = normalizeWorkflowActionThrownError(Object.assign(new Error('private catalog contents'), {
      code: 'account_role_overrides_unavailable',
    }), { operation: 'workflow.run.start', durationMs: 12, emit: event => events.push(event) });
    expect(WorkflowActionFailureV1Schema.parse(result)).toMatchObject({ ok: false, errorCode: 'content_unavailable',
      details: { reason: 'account_role_overrides_unavailable' } });
    expect(events).toEqual([{ event: 'workflow_action_failure', errorCode: 'content_unavailable',
      originalCode: 'account_role_overrides_unavailable', httpStatus: null, operation: 'workflow.run.start', durationMs: 12 }]);
  });

  it('reports invalid requests separately from unavailable private content', async () => {
    const execute = executor();
    await expect(execute({ actionId: 'workflow.definition.get', input: { definitionId: '' }, context: { surface: 'ui' } }))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_input' });
    const input = { runId: definitionId, source: { kind: 'inline' as const, definition }, extra: true };
    await expect(execute({ actionId: 'workflow.run.start', input, context: { surface: 'ui' } }))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_input' });
  });

  it('keeps invalid persisted content unavailable and readable content available', async () => {
    await expect(executor(true)({ actionId: 'workflow.definition.get', input: { definitionId }, context: { surface: 'ui' } }))
      .resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable', details: { reason: 'invalid_header' } });
    await expect(executor()({ actionId: 'workflow.definition.get', input: { definitionId }, context: { surface: 'ui' } }))
      .resolves.toMatchObject({ definitionId, definition });
  });
});
