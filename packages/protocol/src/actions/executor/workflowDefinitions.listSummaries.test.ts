import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionV1Schema } from '../../workflows/workflowV1.js';
import { createWorkflowDefinitionActions } from './workflowDefinitions.js';
import { WorkflowDefinitionListResultV1Schema } from '../../workflows/actionsV1.js';
import { listArtifactHeadersV1 } from '../../artifacts/artifactListSelectionV1.js';

describe('workflow definition library summary read', () => {
  it('opens only Workflow bodies when the Account contains unrelated Artifacts', async () => {
    const definition = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], defaults: {}, blocks: [
      { kind: 'wait', id: 'review', document: { text: 'Review', references: [], attachments: [] } },
    ] });
    const workflowId = '11111111-1111-4111-8111-111111111111';
    const rows = Array.from({ length: 2001 }, (_, index) => ({
      artifactId: index === 2000 ? workflowId : `unrelated-${index}`,
      header: index === 2000 ? { kind: 'workflow-definition.v1', definitionId: workflowId,
        revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Review' } } : { kind: 'role.v1' },
      headerVersion: 1, bodyVersion: 1, createdAt: 3000 - index, updatedAt: 3000 - index,
      ownerAccountId: 'account', access: 'owner' as const,
    }));
    let bodiesRead = 0;
    const body = JSON.stringify({ kind: 'workflow-definition.v1', definition });
    const owner = createWorkflowDefinitionActions({ artifactStore: {
      // Persistence/transport is the boundary. Selection, body demand and the
      // Workflow Action are the real producers consumed in UI and daemon.
      list: options => listArtifactHeadersV1({ options,
        readPage: async request => {
          const start = request?.cursor ? Number(request.cursor) : 0;
          const page = rows.slice(start, start + (request?.limit ?? 500));
          if (request?.includeBody) bodiesRead += page.length;
          return { items: request?.includeBody ? page.map(row => ({ ...row, body })) : page,
            ...(start + page.length < rows.length ? { nextCursor: String(start + page.length) } : {}) };
        },
        readBodies: async selected => { bodiesRead += selected.length; return selected.map(row => ({ ...row, body })); },
        encodeCursor: row => String(rows.findIndex(value => value.artifactId === row.artifactId) + 1),
      }),
      read: async () => { throw new Error('No singleton body reads'); }, create: async () => {},
      update: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }), delete: async () => ({ ok: true }),
    }, encodeListCursor: row => String(rows.findIndex(value => value.artifactId === row.artifactId) + 1),
      assertDefinitionWriteAllowed: () => {}, readWorkflowTriggerSummaries: async () => new Map() });
    const result = await owner.list({});
    expect(WorkflowDefinitionListResultV1Schema.parse(result).definitions).toMatchObject([
      { definitionId: workflowId, contentStatus: 'available', stepCount: 1 },
    ]);
    expect(bodiesRead).toBe(1);
  });

  it.each(['denied', 'list_failed', 'artifact_account_mode_mismatch'])('keeps %s request-wide', async code => {
    const error = Object.assign(new Error(code), { code });
    const owner = createWorkflowDefinitionActions({ artifactStore: {
      list: async () => { throw error; }, read: async () => null, create: async () => {},
      update: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }), delete: async () => ({ ok: true }),
    }, encodeListCursor: () => 'cursor', assertDefinitionWriteAllowed: () => {} });
    await expect(owner.list({})).rejects.toBe(error);
  });
  it('isolates missing and malformed bodies while retaining identity, paging and scheduler facts', async () => {
    const definition = WorkflowDefinitionV1Schema.parse({ version: 1,
      defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
      blocks: [{ kind: 'step', id: 'work', document: { text: 'Work', references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
    });
    const rows = ['good', 'missing', 'malformed', 'last'].map((artifactId, index) => ({
      artifactId, headerVersion: 1, updatedAt: index, ownerAccountId: 'account', access: 'owner' as const,
      header: { kind: 'workflow-definition.v1', definitionId: artifactId, revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: artifactId } },
      ...(artifactId === 'missing' ? {} : { bodyVersion: 1,
        body: artifactId === 'malformed' ? '{' : JSON.stringify({ kind: 'workflow-definition.v1', definition }) }),
    }));
    const owner = createWorkflowDefinitionActions({ artifactStore: {
      list: async ({ cursor }) => ({ items: cursor ? rows.slice(Number(cursor)) : rows }),
      read: async () => { throw new Error('no_per_record_read'); }, create: async () => {},
      update: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }), delete: async () => ({ ok: true }),
    }, encodeListCursor: row => String(rows.findIndex(item => item.artifactId === row.artifactId) + 1),
    assertDefinitionWriteAllowed: () => {}, readWorkflowTriggerSummaries: async () => new Map() });
    const first = await owner.list({ limit: 3 });
    expect(first.definitions).toMatchObject([
      { definitionId: 'good', contentStatus: 'available', stepCount: 1, nextRunAt: null },
      { definitionId: 'missing', contentStatus: 'unavailable', stepCount: null, nextRunAt: null },
      { definitionId: 'malformed', contentStatus: 'unavailable', stepCount: null },
    ]);
    expect(WorkflowDefinitionListResultV1Schema.parse(first)).toEqual(first);
    const next = await owner.list({ cursor: first.nextCursor });
    expect(next.definitions).toMatchObject([{ definitionId: 'last', contentStatus: 'available', stepCount: 1, nextRunAt: null }]);
  });
  it('counts opened authored leaves, excluding containers and repeat occurrences', async () => {
    const step = { kind: 'step', id: 'first', document: { text: 'Do the work', references: [], attachments: [] }, input: [], result: { kind: 'text' } };
    const definition = WorkflowDefinitionV1Schema.parse({ version: 1, defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } }, blocks: [
      { kind: 'parallel', id: 'lanes', failurePolicy: 'fail_stop', branches: [
        { id: 'left', blocks: [step] }, { id: 'right', blocks: [{ ...step, id: 'second' }] },
      ] },
      { kind: 'loop', id: 'repeat', body: [{ ...step, id: 'third' }], repetition: { kind: 'count', count: { kind: 'literal', value: 12 } } },
    ] });
    const row = { artifactId: 'workflow-one', headerVersion: 1, updatedAt: 1, ownerAccountId: 'account', access: 'owner' as const,
      header: { kind: 'workflow-definition.v1', definitionId: 'workflow-one', revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Work' } },
      body: JSON.stringify({ kind: 'workflow-definition.v1', definition }), bodyVersion: 1 };
    const owner = createWorkflowDefinitionActions({ artifactStore: {
      list: async () => ({ items: [row] }),
      read: async () => { throw new Error('library_summary_must_use_batched_opened_content'); },
      create: async () => {}, update: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }), delete: async () => ({ ok: true }),
    }, encodeListCursor: () => 'cursor', assertDefinitionWriteAllowed: () => {},
    readWorkflowTriggerSummaries: async () => new Map([['workflow-one', { triggers: [], nextRunAt: 1_900_000_000_000 }]]) });
    const result = await owner.list({});
    expect(result.definitions[0]).toMatchObject({ stepCount: 3, triggers: [], nextRunAt: 1_900_000_000_000 });
  });
});
