import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import type { PromptLibraryStackActionPortV1 } from '../prompts/library/promptLibraryCatalogV1.js';
import { PromptLibraryRecordV1Schema, type PromptLibraryRecordV1 } from '../prompts/library/promptLibraryRowsV1.js';
import { listPromptInvocationsInLibrary } from '../prompts/library/promptInvocationActionOperations.js';
import { ApprovalRequestV2Schema, type ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { clientActionUnavailable } from './clientDispatchV1.js';

function catalog(options?: Readonly<{ raceBeforeWrite?: boolean; headless?: boolean }>) {
  let record: PromptLibraryRecordV1 = PromptLibraryRecordV1Schema.parse({ key: 'invocations', value: { v: 1,
    entries: [{ id: 'saved', token: '/daily', title: 'Daily',
      target: { kind: 'doc', artifactId: 'doc', serverId: 'other-home' }, availableIn: 'session_only' }] } });
  let revision = 4;
  let writes = 0;
  const port: PromptLibraryStackActionPortV1 = {
    serverId: 'home', assertCurrent() {},
    readCatalog: async () => ({ catalog: { status: 'ready', rows: [{ record, revision }], tombstones: [], diagnostics: [] } }),
    writeRecord: async input => {
      writes++;
      if (options?.raceBeforeWrite) {
        record = PromptLibraryRecordV1Schema.parse({ key: 'invocations', value: { v: 1, entries: [{
          id: 'saved', token: '/winner', title: 'Winner', target: { kind: 'doc', artifactId: 'winner' },
        }] } });
        revision++;
      }
      if (input.expectedRevision !== revision) return { status: 'conflict', revision };
      record = PromptLibraryRecordV1Schema.parse(input.record); revision++;
      return { status: 'updated', revision, cursor: revision };
    },
  };
  // This fixture binds only the catalog persistence boundary; unrelated effect ports stay absent.
  let approval: ApprovalRequest | null = null;
  const approvalDeps: Partial<ActionExecutorDeps> = options?.headless ? {
    // Durable Artifact persistence is a system boundary. Admission and replay remain real.
    approvalsCreate: async ({ request }) => { approval = ApprovalRequestV2Schema.parse(request); return { artifactId: 'approval' }; },
    approvalsGet: async () => approval,
    approvalsUpdate: async ({ request }) => { approval = ApprovalRequestV2Schema.parse(request); return { ok: true }; },
    isApprovalExecutionOriginCurrent: async () => true,
    clientActionExecute: async ({ actionId }) => clientActionUnavailable(actionId),
  } : {};
  const executor = createActionExecutor({ promptStacks: port, ...approvalDeps } as ActionExecutorDeps);
  return { read: () => ({ record, revision, writes, approval }), executor };
}

describe('prompt invocation mutations through Action admission and catalog CAS', () => {
  it.each(['prompts.invocation.create', 'prompts.invocation.update', 'prompts.invocation.delete'] as const)(
    'replays %s from a CLI approver without a mounted client', async actionId => {
      const state = catalog({ headless: true });
      const input = actionId === 'prompts.invocation.create'
        ? { token: 'new-shortcut', title: 'New shortcut', target: { kind: 'doc', artifactId: 'doc' } }
        : { invocationId: 'saved', expectedRevision: 4, ...(actionId.endsWith('update')
          ? { token: 'changed', title: 'Changed', target: { kind: 'doc', artifactId: 'doc' } } : {}) };
      expect(await state.executor.execute(actionId, input, { surface: 'cli', authority: 'account_automation',
        serverId: 'home', serverIdentityId: 'srv_home', runtimeAccountId: 'account', actionRequestId: 'proposal' }))
        .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      expect(state.read().writes).toBe(0);
      const decision = await state.executor.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' }, {
        surface: 'cli', authority: 'present_user', serverId: 'home', serverIdentityId: 'srv_home', runtimeAccountId: 'account',
      });
      expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
      expect(state.read()).toMatchObject({ writes: 1, revision: 5, approval: { status: 'executed' } });
      const persisted = state.read().approval;
      if (!persisted?.execution?.ok) throw new Error('Expected executed approval');
      expect(getActionSpec(actionId).outputSchema?.parse(persisted.execution.result)).toEqual(persisted.execution.result);
    });
  it('supplies the editable target and catalog revision from the existing list projection', () => {
    const state = catalog().read();
    expect(listPromptInvocationsInLibrary({ invocations: state.record.value, revision: state.revision, request: {} }))
      .toMatchObject({ revision: 4, items: [{ id: 'saved', target: { kind: 'doc', artifactId: 'doc', serverId: 'other-home' } }] });
  });
  it('updates and deletes a saved shortcut through the registered executor and exact output consumer', async () => {
    const state = catalog();
    const update = ActionIdSchema.parse('prompts.invocation.update');
    const remove = ActionIdSchema.parse('prompts.invocation.delete');
    const context = { surface: 'ui' as const, authority: 'present_user' as const,
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { [remove]: ['ui'] } }) };
    const updated = await state.executor.execute(update, { invocationId: 'saved', expectedRevision: 4,
      token: 'weekly', title: 'Weekly', target: { kind: 'doc', artifactId: 'doc', serverId: 'other-home' },
      behavior: 'insert_and_send', allowArgs: true, availableIn: 'session_only' }, context);
    expect(updated).toEqual({ ok: true, result: { status: 'updated', invocationId: 'saved', token: '/weekly', revision: 5 } });
    if (updated.ok) expect(getActionSpec(update).outputSchema?.parse(updated.result)).toEqual(updated.result);
    expect(state.read().record.value).toMatchObject({ entries: [{ id: 'saved',
      token: '/weekly', target: { serverId: 'other-home' }, availableIn: 'session_only' }] });
    const deleted = await state.executor.execute(remove, { invocationId: 'saved', expectedRevision: 5 }, context);
    expect(deleted).toEqual({ ok: true, result: { status: 'updated', invocationId: 'saved', revision: 6 } });
    if (deleted.ok) expect(getActionSpec(remove).outputSchema?.parse(deleted.result)).toEqual(deleted.result);
    expect(state.read().record.value).toEqual({ v: 1, entries: [] });
  });

  it('retains the submitted revision after approval delay and never rebases a stale edit or removal', async () => {
    const state = catalog();
    for (const id of ['prompts.invocation.update', 'prompts.invocation.delete']) {
      const actionId = ActionIdSchema.parse(id);
      const input = { invocationId: 'saved', expectedRevision: 3,
        ...(id.endsWith('update') ? { token: 'changed', title: 'Changed', target: { kind: 'doc', artifactId: 'doc' } } : {}) };
      expect(await state.executor.execute(actionId, input, { surface: 'mcp', authority: 'account_automation',
        actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { [actionId]: ['mcp'] } }) }))
        .toEqual({ ok: true, result: { status: 'conflict', revision: 4 } });
    }
    expect(state.read().writes).toBe(0);
  });

  it('keeps Off and Ask-first in the executor before either mutation reaches storage', async () => {
    const state = catalog();
    for (const id of ['prompts.invocation.update', 'prompts.invocation.delete']) {
      const actionId = ActionIdSchema.parse(id);
      const input = { invocationId: 'saved', expectedRevision: 4,
        ...(id.endsWith('update') ? { token: 'changed', title: 'Changed', target: { kind: 'doc', artifactId: 'doc' } } : {}) };
      expect(await state.executor.execute(actionId, input, { surface: 'ui', authority: 'present_user',
        actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: { [actionId]: { enabled: false } } }) })).toMatchObject({ ok: false, errorCode: 'action_disabled' });
      expect(await state.executor.execute(actionId, input, { surface: 'ui', authority: 'present_user',
        actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } }) }))
        .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    }
    expect(state.read().writes).toBe(0);
  });

  it.each(['prompts.invocation.update', 'prompts.invocation.delete'])('preserves the concurrent CAS winner for %s', async id => {
    const state = catalog({ raceBeforeWrite: true });
    const actionId = ActionIdSchema.parse(id);
    const result = await state.executor.execute(actionId, { invocationId: 'saved', expectedRevision: 4,
      ...(id.endsWith('update') ? { token: 'changed', title: 'Changed', target: { kind: 'doc', artifactId: 'doc' } } : {}) }, {
      surface: 'cli', authority: 'account_automation',
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { [actionId]: ['cli'] } }),
    });
    expect(result).toEqual({ ok: true, result: { status: 'conflict', revision: 5 } });
    expect(state.read().record.value).toMatchObject({ entries: [{ id: 'saved', title: 'Winner' }] });
    expect(state.read().writes).toBe(1);
  });
});
