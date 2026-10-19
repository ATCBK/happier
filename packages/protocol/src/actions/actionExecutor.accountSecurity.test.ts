import { describe, expect, it, vi } from 'vitest';

import { ApprovalRequestV2Schema, type ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { createActionExecutor } from './actionExecutor.js';
import type { ActionExecutorDeps } from './executor/types.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';

function createDeps(overrides: Partial<ActionExecutorDeps> = {}): ActionExecutorDeps {
  return {
    executionRunStart: vi.fn(async () => ({})),
    executionRunList: vi.fn(async () => ({})),
    executionRunGet: vi.fn(async () => ({})),
    detachedExecutionRunSend: vi.fn(async () => ({})),
    executionRunStop: vi.fn(async () => ({})),
    executionRunAction: vi.fn(async () => ({})),
    executionRunWait: vi.fn(async () => ({})),
    sessionOpen: vi.fn(async () => ({})),
    sessionFork: vi.fn(async () => ({})),
    sessionRollback: vi.fn(async () => ({})),
    sessionSpawnNew: vi.fn(async () => ({})),
    pathsListRecent: vi.fn(async () => ({ items: [] })),
    machinesList: vi.fn(async () => ({ items: [] })),
    serversList: vi.fn(async () => ({ items: [] })),
    reviewEnginesList: vi.fn(async () => ({ items: [] })),
    agentsBackendsList: vi.fn(async () => ({ items: [] })),
    agentsModelsList: vi.fn(async () => ({ items: [] })),
    sessionSendMessage: vi.fn(async () => ({})),
    sessionPermissionRespond: vi.fn(async () => ({})),
    sessionUserActionAnswer: vi.fn(async () => ({})),
    sessionModeSet: vi.fn(async () => ({})),
    sessionModesList: vi.fn(async () => ({ items: [] })),
    sessionTargetPrimarySet: vi.fn(async () => ({})),
    sessionTargetTrackedSet: vi.fn(async () => ({})),
    sessionList: vi.fn(async () => ({})),
    sessionActivityGet: vi.fn(async () => ({})),
    sessionRecentMessagesGet: vi.fn(async () => ({})),
    resetGlobalVoiceAgent: vi.fn(),
    ...overrides,
  };
}

describe('createActionExecutor (Account Security)', () => {
  it.each(['ui-default', 'ui-ask', 'agent', 'mcp'] as const)(
    'routes a connected-account rename through the declared policy (%s)', async scenario => {
      const persisted: ApprovalRequest[] = [];
      let label = 'Before';
      let confirmations = 0;
      const actionId = 'connectedServices.accounts.rename';
      const input = { account: { service: { pluginId: 'happier.agent.codex', localId: 'openai' }, accountId: 'work' }, label: 'After' };
      const executor = createActionExecutor(createDeps({
        // Account persistence and the Artifact store are system boundaries;
        // declaration lookup, input admission and approval routing stay real.
        connectedServiceAction: async ({ input: admitted }) => {
          if (admitted !== null && typeof admitted === 'object' && 'label' in admitted && typeof admitted.label === 'string') {
            label = admitted.label;
          }
          return { applied: true };
        },
        presentUserActionConfirmation: async () => { confirmations += 1; return true; },
        approvalsCreate: async ({ request }) => {
          persisted.push(ApprovalRequestV2Schema.parse(request));
          return { artifactId: 'rename-approval' };
        },
        approvalsUpdate: async () => ({ ok: true }),
        approvalsWaitForDecision: async ({ request }) => ({ decision: 'reject', request }),
      }));
      const settings = normalizeActionsSettingsV1({ v: 1, actions: scenario === 'ui-ask'
        ? { [actionId]: { approvalRequiredSurfaces: ['ui'] } } : {} });
      const result = await executor.execute(actionId, input, {
        surface: scenario === 'agent' || scenario === 'mcp' ? scenario : 'ui',
        authority: scenario === 'agent' || scenario === 'mcp' ? 'account_automation' : 'present_user',
        actionCaller: { kind: 'host' }, serverId: 'home', runtimeAccountId: 'account',
        actionRequestId: `rename-${scenario}`, defaultSessionId: 'requesting-session', actionsSettings: settings,
      });
      expect(confirmations).toBe(0);
      if (scenario === 'ui-default') {
        expect(result).toEqual({ ok: true, result: { applied: true } });
        expect(label).toBe('After');
        expect(persisted).toEqual([]);
      } else {
        expect(result).toMatchObject(scenario === 'ui-ask'
          ? { ok: true, result: { kind: 'approval_request_created', artifactId: 'rename-approval', actionId } }
          : { ok: false, errorCode: 'approval_rejected' });
        expect(label).toBe('Before');
        expect(persisted).toHaveLength(1);
        expect(persisted[0]).toMatchObject({ actionId, actionArgs: input, status: 'open',
          executionOriginV1: { authority: scenario === 'ui-ask' ? 'present_user' : 'account_automation' } });
      }
    },
  );

  it('dispatches only present-user input and removes password material from execution history', async () => {
    const accountPasswordChangeAction = vi.fn(async () => ({ v: 1 as const, status: 'updated' as const }));
    const observeActionExecution = vi.fn();
    const executor = createActionExecutor(createDeps({
      accountPasswordChangeAction,
      observeActionExecution,
      interceptActionExecution: async ({ input }) => ({ status: 'continue', input }),
      isActionApprovalRequired: () => false,
    }));
    const input = {
      v: 1 as const,
      kind: 'plain' as const,
      expectedCredentialRevision: 7,
      currentPassword: 'current highly secret password',
      newPassword: 'replacement highly secret password',
    };
    const context = {
      surface: 'cli' as const,
      authority: 'present_user' as const,
      actionCaller: { kind: 'host' as const },
    };

    await expect(executor.execute('account.password.change', input, context)).resolves.toEqual({
      ok: true,
      result: { v: 1, status: 'updated' },
    });
    expect(accountPasswordChangeAction).toHaveBeenCalledWith({ input, context });
    expect(observeActionExecution).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'account.password.change',
      input: { v: 1, kind: 'plain', expectedCredentialRevision: 7 },
    }));
    expect(JSON.stringify(observeActionExecution.mock.calls)).not.toContain('highly secret');

    await expect(executor.execute('account.password.change', input, {
      ...context,
      authority: 'account_automation',
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      errorCode: 'present_user_required',
    }));
    expect(accountPasswordChangeAction).toHaveBeenCalledTimes(1);
  });

  it('keeps a required credential confirmation on its live invocation and never persists credential material', async () => {
    const persisted: ApprovalRequest[] = [];
    const accountPasswordChangeAction = vi.fn(async () => ({ v: 1 as const, status: 'updated' as const }));
    const executor = createActionExecutor(createDeps({
      accountPasswordChangeAction,
      isActionApprovalRequired: (actionId, context) => (
        actionId === 'account.password.change'
        && context.surface === 'ui'
        && context.authority === 'present_user'
      ),
      approvalsCreate: async ({ request }) => {
        persisted.push(ApprovalRequestV2Schema.parse(request));
        return { artifactId: 'ui-password-approval' };
      },
      approvalsGet: async () => persisted.at(-1) ?? null,
      approvalsUpdate: async ({ request }) => {
        persisted.push(ApprovalRequestV2Schema.parse(request));
        return { ok: true as const };
      },
      approvalsWaitForDecision: async ({ request }) => ({
        decision: 'approve' as const,
        request: {
          ...request,
          status: 'approved' as const,
          decision: { kind: 'approve' as const, decidedAtMs: 2 },
        },
      }),
      isApprovalExecutionOriginCurrent: async () => true,
    }));
    const input = {
      v: 1 as const,
      kind: 'plain' as const,
      expectedCredentialRevision: 7,
      currentPassword: 'current highly secret password',
      newPassword: 'replacement highly secret password',
    };

    await expect(executor.execute('account.password.change', input, {
      surface: 'ui' as const,
      authority: 'present_user' as const,
      serverId: 'server-1',
      runtimeAccountId: 'account-1',
      actionRequestId: 'request-password-change-1',
      actionCaller: { kind: 'host' as const },
    })).resolves.toEqual({ ok: true, result: { v: 1, status: 'updated' } });

    // The live invocation stays the waiter and keeps custody of the raw input.
    expect(accountPasswordChangeAction).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ input }),
    );
    const created = persisted.at(0);
    expect(created?.approval).toEqual({ flow: 'blocking', result: 'required' });
    expect(created?.actionArgs).toEqual({ v: 1, kind: 'plain', expectedCredentialRevision: 7 });
    expect(JSON.stringify(persisted)).not.toContain('highly secret');
  });

  it('refuses a durable approval request for a live-only credential input', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'never' }));
    const executor = createActionExecutor(createDeps({
      approvalsCreate,
      isActionApprovalRequired: () => false,
    }));

    await expect(executor.execute('approval.request.create', {
      actionId: 'account.password.change',
      actionArgs: {
        v: 1,
        kind: 'plain',
        expectedCredentialRevision: 7,
        currentPassword: 'current highly secret password',
        newPassword: 'replacement highly secret password',
      },
      summary: 'Change password',
      createdBy: { surface: 'system' },
    }, {
      surface: 'ui' as const,
      authority: 'present_user' as const,
      serverId: 'server-1',
      runtimeAccountId: 'account-1',
      actionRequestId: 'request-password-change-2',
      actionCaller: { kind: 'host' as const },
    })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(approvalsCreate).not.toHaveBeenCalled();
  });

  it.each([
    { machineId: 'machine-1', target: { kind: 'attempt' as const, attemptId: 'attempt-1' } },
    { service: { pluginId: 'happier.channel.email', localId: 'email-imap-smtp' }, modeId: 'password' },
  ])('keeps configuration approval placement on the admitted target without persisting its values: %j', async (target) => {
    const persisted: ApprovalRequest[] = [];
    const input = { ...target, expectedRevision: null, values: { mailbox: 'wilson@test.local' },
      secretValues: { password: 'private-configuration-value' } };
    let committed: unknown;
    const executor = createActionExecutor(createDeps({
      // The daemon/Home configuration writer is the external boundary. Its
      // producer input still passes the actual Action schema before committing.
      connectedServiceAction: async ({ input: replacement }) => {
        const { CONNECTED_SERVICE_CONFIGURATION_ACTION_INPUT_SCHEMAS_V1 } = await import('../connect/configurationActionsV1.js');
        committed = CONNECTED_SERVICE_CONFIGURATION_ACTION_INPUT_SCHEMAS_V1['connectedServices.configuration.replace'].parse(replacement);
        return { applied: true, revision: 'configuration-1' };
      },
      approvalsCreate: async ({ request }) => {
        persisted.push(ApprovalRequestV2Schema.parse(request));
        return { artifactId: 'configuration-approval' };
      },
      approvalsGet: async () => persisted.at(-1) ?? null,
      approvalsUpdate: async ({ request }) => {
        persisted.push(ApprovalRequestV2Schema.parse(request));
        return { ok: true as const };
      },
      approvalsWaitForDecision: async ({ request }) => ({ decision: 'approve' as const,
        request: { ...request, status: 'approved' as const, decision: { kind: 'approve' as const, decidedAtMs: 2 } } }),
      isApprovalExecutionOriginCurrent: async () => true,
    }));
    await expect(executor.execute('connectedServices.configuration.replace', input, {
      surface: 'ui', authority: 'present_user', serverId: 'server-1', runtimeAccountId: 'account-1',
      actionRequestId: 'request-configuration', actionCaller: { kind: 'host' },
    })).resolves.toEqual({ ok: true, result: { applied: true, revision: 'configuration-1' } });
    expect(committed).toEqual(input);
    const origin = persisted[0]?.v === 2 ? persisted[0].executionOriginV1 : null;
    expect(origin?.machineId).toBe('machineId' in target ? target.machineId : undefined);
    expect(persisted[0]?.actionArgs).toEqual({ ...target, expectedRevision: null });
    expect(JSON.stringify(persisted)).not.toContain('private-configuration-value');
    expect(JSON.stringify(persisted)).not.toContain('wilson@test.local');
  });

  it('fails a durable credential approval closed instead of replaying it from the Artifact', async () => {
    const accountPasswordChangeAction = vi.fn(async () => ({ v: 1 as const, status: 'updated' as const }));
    let storedRequest: ApprovalRequest = ApprovalRequestV2Schema.parse({
      v: 2,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'system' },
      requestedSurface: 'ui',
      actionId: 'account.password.change',
      // A record created before input custody was declared, or forged: the raw
      // credential material must never be executed from durable state.
      actionArgs: {
        v: 1,
        kind: 'plain',
        expectedCredentialRevision: 7,
        currentPassword: 'current highly secret password',
        newPassword: 'replacement highly secret password',
      },
      summary: 'Change password',
      executionOriginV1: {
        v: 1,
        authority: 'present_user',
        surface: 'ui',
        caller: { kind: 'host' },
        serverId: 'server-1',
        accountId: 'account-1',
        actionId: 'account.password.change',
        requestId: 'request-password-change-3',
      },
    });
    const executor = createActionExecutor(createDeps({
      accountPasswordChangeAction,
      approvalsGet: async () => storedRequest,
      approvalsUpdate: async ({ request }) => {
        storedRequest = ApprovalRequestV2Schema.parse(request);
        return { ok: true as const };
      },
      isApprovalExecutionOriginCurrent: async () => true,
    }));

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'stale-password-approval',
      decision: 'approve',
    }, {
      surface: 'ui' as const,
      authority: 'present_user' as const,
      serverId: 'server-1',
      actionCaller: { kind: 'host' as const },
    })).resolves.toMatchObject({
      ok: true,
      result: { status: 'failed', execution: { ok: false, errorCode: 'approval_stale' } },
    });
    expect(accountPasswordChangeAction).not.toHaveBeenCalled();
  });
});
