import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps, RPC_METHODS, UiActionDispatchRequestV1Schema, ActionIdSchema } from '@happier-dev/protocol';
import { createClientActionReverseDispatcher, type ClientActionMachineRpc } from './clientActionReverseDispatch';
import { createCliSettingsDeclarationAction } from './settingsDeclarationAction';
import { mountedWorkReadClientRpcMethod } from '@happier-dev/protocol/actions/clientDispatchV1';

function executor(client: ClientActionMachineRpc | null) {
  return createActionExecutor({ clientActionExecute: createClientActionReverseDispatcher(() => client),
    settingsDeclarationAction: createCliSettingsDeclarationAction({}) } as unknown as ActionExecutorDeps);
}

const disconnectedClient: ClientActionMachineRpc = {
  hasConnectedClientRpcHandler: () => false,
  callConnectedClientRpc: async () => { throw new Error('must not issue without a registered client'); },
};

describe('client Action reverse delivery', () => {
  it.each(['cli', 'mcp'] as const)('addresses Run-on mutations to an exact answering client from %s', async surface => {
    const client: ClientActionMachineRpc = {
      hasConnectedClientRpcHandler: () => true,
      callConnectedClientRpc: async (_method, raw, options) => {
        const request = UiActionDispatchRequestV1Schema.parse(raw);
        expect(options).toMatchObject({ answeringClient: { clientId: 'app-b', requireSingle: true } });
        expect(request.input).toEqual({ pluginId: 'acme.plugin', clientId: 'app-b' });
        options.onIssued();
        return { ok: true, result: { v: 1, execution: { ok: true, result: { status: 'applied' } } } };
      },
    };
    expect(await executor(client).execute('plugins.execution_origin.clear', { pluginId: 'acme.plugin', clientId: 'app-b' },
      { surface, authority: 'account_automation' })).toEqual({ ok: true, result: { status: 'applied' } });
  });

  it('keeps a typed no-effect ambiguity even after the reverse transport was issued', async () => {
    const client: ClientActionMachineRpc = {
      hasConnectedClientRpcHandler: () => true,
      callConnectedClientRpc: async (_method, _raw, options) => {
        expect(options).toMatchObject({ answeringClient: { requireSingle: true } });
        options.onIssued();
        return { ok: false, errorCode: 'RPC_CLIENT_AMBIGUOUS' };
      },
    };
    expect(await executor(client).execute('plugins.execution_origin.clear', { pluginId: 'acme.plugin' },
      { surface: 'cli', authority: 'account_automation' })).toMatchObject({ ok: false, errorCode: 'client_ambiguous' });
  });
  it('keeps Run-on reads unambiguous and exposes current client addresses for the next mutation', async () => {
    const result = { status: 'available', storedTarget: null, storedOrigin: null, selectedOrigin: null, selectionSource: null, candidates: [] };
    const client: ClientActionMachineRpc = {
      hasConnectedClientRpcHandler: () => true,
      callConnectedClientRpc: async (_method, _raw, options) => {
        expect(options.answeringClient).toEqual({});
        options.onIssued();
        return { ok: true, result: { v: 1, execution: { ok: true, result } },
          answeringClientId: 'app-a', answeringClientIds: ['app-a', 'app-b'] };
      },
    };
    expect(await executor(client).execute('plugins.execution_origin.list', { pluginId: 'acme.plugin' },
      { surface: 'mcp', authority: 'account_automation' })).toEqual({ ok: true,
        result: { ...result, answeringClientId: 'app-a', answeringClientIds: ['app-a', 'app-b'] } });
  });
  it.each([
    { actionId: 'workspace.tabs.list', input: {}, result: { ok: true, tabs: [], groups: [], splits: [], rootNodeId: 'main', focusedGroupId: 'main', maximizedGroupId: null } },
  ] as const)('admits $actionId from CLI and preserves its surface through mounted-client delivery', async request => {
    const client: ClientActionMachineRpc = {
      hasConnectedClientRpcHandler: method => method === RPC_METHODS.UI_ACTION_EXECUTE,
      // Only the network hop is substituted; admission, carrier and output validation remain real.
      callConnectedClientRpc: async (_method, payload, options) => {
        expect(UiActionDispatchRequestV1Schema.parse(payload)).toMatchObject({
          actionId: request.actionId, input: request.input, context: { surface: 'cli', authority: 'account_automation' },
        });
        options.onIssued();
        return { ok: true, result: { v: 1, execution: { ok: true, result: request.result } } };
      },
    };
    const context = { surface: 'cli', authority: 'account_automation', serverId: 'home', bypassApprovals: true } as const;
    expect(await executor(client).execute(request.actionId, request.input, context)).toEqual({ ok: true, result: request.result });
    expect(await executor(disconnectedClient).execute(request.actionId, request.input, context)).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
  });
  it('discovers and delegates keyed device Storage preferences without admitting unsupported Account keys', async () => {
    const anchor = 'machines.storage.view';
    const key = 'home\u0000machine';
    const value = { shape: 'rings', sort: { by: 'size', direction: 'desc' } };
    const delivered: unknown[] = [];
    const client: ClientActionMachineRpc = {
      hasConnectedClientRpcHandler: method => method === RPC_METHODS.UI_ACTION_EXECUTE,
      // Only the Machine-to-App process hop is synthetic; declaration admission and routing stay real.
      callConnectedClientRpc: async (method, payload, options) => {
        expect(method).toBe(RPC_METHODS.UI_ACTION_EXECUTE);
        const request = UiActionDispatchRequestV1Schema.parse(payload);
        expect(request.input).toEqual({ anchor, key, ...(request.actionId === 'settings.set' ? { value } : {}) });
        delivered.push(request.input);
        options.onIssued();
        return { ok: true, result: { v: 1, execution: { ok: true, result: { anchor, value } } } };
      },
    };
    expect(await executor(null).execute('settings.list', { pageId: 'machines' }, { surface: 'agent' }))
      .toMatchObject({ ok: true, result: { items: expect.arrayContaining([expect.objectContaining({
        anchor, storageScope: 'local', readable: true, writable: true,
      })]) } });
    for (const surface of ['cli', 'agent', 'mcp'] as const) {
      const context = { surface, authority: 'account_automation', bypassApprovals: true } as const;
      expect(await executor(client).execute('settings.get', { anchor, key }, context)).toEqual({ ok: true, result: { anchor, value } });
      expect(await executor(client).execute('settings.set', { anchor, key, value }, context)).toEqual({ ok: true, result: { anchor, value } });
      expect(await executor(disconnectedClient).execute('settings.get', { anchor, key }, context))
        .toMatchObject({ ok: false, errorCode: 'unavailable', details: { reason: 'client_unavailable', recovery: { kind: 'connect_client' } } });
    }
    expect(delivered).toHaveLength(6);
    expect(await executor(client).execute('settings.get', { anchor: 'delegation.workDepthLimit', key: 'unsupported' }, { surface: 'agent' }))
      .toMatchObject({ ok: false, errorCode: 'setting_key_unsupported' });
    expect(delivered).toHaveLength(6);
  });
  it.each([
    { actionId: 'ui.current_context.read', input: {}, result: {
      navigation: { area: 'settings', screen: 'usage' }, commands: [{ id: 'current-ui:usage:period', title: 'Last 30 days' }],
    } },
    { actionId: 'ui.current_context.command.invoke', input: { commandId: 'current-ui:usage:period' }, result: null },
  ] as const)('delivers Usage mounted $actionId from CLI through its canonical answering client', async request => {
    const expectedMethod = request.actionId === 'ui.current_context.read'
      ? `${RPC_METHODS.UI_ACTION_EXECUTE}.current-context.read`
      : `${RPC_METHODS.UI_ACTION_EXECUTE}.current-context.command.${encodeURIComponent(JSON.stringify(request.input.commandId))}`;
    const client: ClientActionMachineRpc = {
      hasConnectedClientRpcHandler: method => method === expectedMethod,
      callConnectedClientRpc: async (method, payload, options) => {
        expect(method).toBe(expectedMethod);
        expect(UiActionDispatchRequestV1Schema.parse(payload)).toMatchObject({
          actionId: request.actionId, input: request.input, context: { surface: 'cli', authority: 'account_automation' },
        });
        options.onIssued();
        return { ok: true, result: { v: 1, execution: { ok: true, result: request.result } } };
      },
    };
    const context = { surface: 'cli', authority: 'account_automation', serverId: 'home' } as const;
    expect(await executor(client).execute(request.actionId, request.input, context)).toEqual({ ok: true, result: request.result });
    expect(await executor(disconnectedClient).execute(request.actionId, request.input, context))
      .toMatchObject({ ok: false, errorCode: 'unavailable', error: 'noClient' });
    expect(await executor(null).execute(request.actionId, request.input, context)).toEqual({
      ok: false, errorCode: 'machine_transport_unavailable', error: 'machine_transport_unavailable',
    });
  });

  it.each([
    ['response', 'machine_socket_unavailable'],
    ['throw', 'machine_transport_unavailable'],
  ] as const)('does not report a pre-issue reverse transport %s as noClient', async (disposition, expectedErrorCode) => {
    let deliveries = 0;
    const client: ClientActionMachineRpc = {
      hasConnectedClientRpcHandler: () => true,
      callConnectedClientRpc: async () => {
        deliveries += 1;
        if (disposition === 'throw') throw new Error('machine transport unavailable');
        return { ok: false, errorCode: 'machine_socket_unavailable' };
      },
    };
    await expect(executor(client).execute('ui.current_context.read', {}, {
      surface: 'agent', authority: 'account_automation', serverId: 'home',
    })).resolves.toEqual({
      ok: false, errorCode: expectedErrorCode, error: expectedErrorCode,
    });
    expect(deliveries).toBe(1);
  });

  it('delivers a direct Home continuation to the App that owns its opaque current-context command', async () => {
    const input = { operation: 'refresh' as const, commandId: 'current-ui:home:refresh' };
    const expectedMethod = `${RPC_METHODS.UI_ACTION_EXECUTE}.current-context.command.${encodeURIComponent(JSON.stringify(input.commandId))}`;
    const client: ClientActionMachineRpc = {
      hasConnectedClientRpcHandler: method => method === expectedMethod,
      callConnectedClientRpc: async (method, payload, options) => {
        expect(method).toBe(expectedMethod);
        expect(UiActionDispatchRequestV1Schema.parse(payload)).toMatchObject({
          actionId: 'account.home_continuation.invoke', input,
          context: { surface: 'agent', authority: 'present_user' },
        });
        options.onIssued();
        return { ok: true, result: { v: 1, execution: { ok: true, result: { status: 'completed' } } } };
      },
    };
    const context = { surface: 'agent', authority: 'present_user', bypassApprovals: true, serverId: 'home' } as const;
    await expect(executor(client).execute('account.home_continuation.invoke', input, context))
      .resolves.toEqual({ ok: true, result: { status: 'completed' } });
  });

  it.each([
    { actionId: 'session.work.get', input: { sessionId: 'lead' }, result: {
      status: 'ready', sessionId: 'lead', summary: { outstanding: 1, needsYou: 0, stalled: 0, sessions: 1, runs: 0 },
      items: [], managedRuns: { phase: 'loaded', refreshFailed: false },
    }, absent: { ok: true, result: { status: 'unavailable' } } },
    { actionId: 'inbox.mark_all_read', input: { targets: [{ serverId: 'home', sessionId: 'lead' }] },
      result: { results: [{ serverId: 'home', sessionId: 'lead', status: 'succeeded' }] },
      absent: { ok: false, errorCode: 'unavailable', error: 'noClient' } },
    { actionId: 'session.draft.append', input: { sessionId: 'lead', text: 'Follow-up', sourceSessionId: 'worker' },
      result: { status: 'appended', sessionId: 'lead', createdAtMs: 10 },
      absent: { ok: true, result: { status: 'unavailable' } } },
    { actionId: 'session.draft.delete', input: { draftId: '00000000-0000-4000-8000-000000000001' },
      result: { status: 'deleted' }, absent: expect.objectContaining({ ok: false, errorCode: 'unavailable', error: 'noClient',
        details: expect.objectContaining({ reason: 'client_unavailable', recovery: expect.objectContaining({ kind: 'connect_client' }) }) }) },
    { actionId: 'session.draft.directory.set', input: { ref: { kind: 'newSession', instanceId: 'new-composer' },
      directory: { kind: 'path', path: '/checkout' } }, result: { status: 'applied' },
      absent: { ok: true, result: { status: 'unavailable' } } },
  ] as const)('invokes $actionId from CLI through the answering client and reports typed absence', async request => {
    const expectedMethod = request.actionId === 'session.work.get'
      ? mountedWorkReadClientRpcMethod(request.actionId, request.input.sessionId)
      : RPC_METHODS.UI_ACTION_EXECUTE;
    const client: ClientActionMachineRpc = {
      hasConnectedClientRpcHandler: method => method === expectedMethod,
      // Replace only the process/network hop; admission and result validation stay real.
      callConnectedClientRpc: async (_method, payload, options) => {
        expect(_method).toBe(expectedMethod);
        expect(UiActionDispatchRequestV1Schema.parse(payload)).toMatchObject({
          actionId: request.actionId, input: request.input, context: { surface: 'cli', authority: 'present_user' },
        });
        options.onIssued();
        return { ok: true, result: { v: 1, execution: { ok: true, result: request.result } } };
      },
    };
    const context = { surface: 'cli', authority: 'present_user', serverId: 'home',
      presentUserConfirmation: { actionId: request.actionId } } as const;
    expect(await executor(client).execute(request.actionId, request.input, context)).toEqual({ ok: true, result: request.result });
    expect(await executor(disconnectedClient).execute(request.actionId, request.input, context)).toEqual(request.absent);
  });

  it.each(['session.work.get'] as const)('preserves mounted-owner absence for %s when a client is connected', async actionId => {
    const client: ClientActionMachineRpc = {
      hasConnectedClientRpcHandler: () => true,
      callConnectedClientRpc: async (_method, _payload, options) => {
        options.onIssued();
        return { ok: true, result: { v: 1, execution: { ok: true, result: { status: 'unavailable' } } } };
      },
    };
    expect(await executor(client).execute(actionId, actionId === 'session.work.get' ? { sessionId: 'unmounted' } : {},
      { surface: 'cli', authority: 'present_user', serverId: 'home' })).toEqual({ ok: true, result: { status: 'unavailable' } });
  });

  it('opens the exact comparison through the answering client without resuming a Session headlessly', async () => {
    const input = { sessionId: 'session', serverId: 'home', destination: { kind: 'scmReview',
      comparison: { kind: 'workingTree' }, view: 'walkthrough', explain: true, comparisonId: 'a'.repeat(64) } } as const;
    const client: ClientActionMachineRpc = {
      hasConnectedClientRpcHandler: method => method === RPC_METHODS.UI_ACTION_EXECUTE,
      callConnectedClientRpc: async (_method, payload, options) => {
        expect(UiActionDispatchRequestV1Schema.parse(payload)).toMatchObject({ actionId: 'session.open', input,
          context: { surface: 'cli', authority: 'present_user' } });
        options.onIssued();
        return { ok: true, result: { v: 1, execution: { ok: true, result: {
          status: 'opened', sessionId: input.sessionId, serverId: input.serverId,
        } } } };
      },
    };
    const context = { surface: 'cli', authority: 'present_user', serverId: 'home' } as const;
    await expect(executor(client).execute('session.open', input, context)).resolves.toEqual({ ok: true,
      result: { status: 'opened', sessionId: 'session', serverId: 'home' } });
    await expect(executor(disconnectedClient).execute('session.open', input, context)).resolves.toMatchObject({
      ok: false, errorCode: 'unavailable', error: 'noClient',
    });
  });
  it.each(['agent', 'mcp'] as const)('delivers the secret-free SSH lifecycle to the answering App for %s', async surface => {
    const operations = [
      { actionId: 'machines.add.ssh.start', input: { serverId: 'home', savedHostId: 'saved-box', expectedHostRevision: 4 }, result: { taskId: 'ssh-task' } },
      { actionId: 'machines.add.ssh.status', input: { taskId: 'ssh-task' }, result: { taskId: 'ssh-task', status: 'running', currentStepId: null,
        awaitingInput: true, prompt: { kind: 'ssh.password', message: 'Password needed', requiresPresentUser: false }, machineId: null, errorCode: null } },
      { actionId: 'machines.add.ssh.respond', input: { taskId: 'ssh-task', answer: { kind: 'ssh.password' } }, result: { taskId: 'ssh-task' } },
      { actionId: 'machines.add.ssh.cancel', input: { taskId: 'ssh-task' }, result: { taskId: 'ssh-task' } },
      { actionId: 'machines.add.ssh.cancel', input: {}, result: { pendingCanceled: true } },
    ] as const;
    let delivered = 0;
    const client: ClientActionMachineRpc = {
      hasConnectedClientRpcHandler: method => method === RPC_METHODS.UI_ACTION_EXECUTE,
      // The other process is the boundary; the UI owner lifecycle runs in its own suite.
      callConnectedClientRpc: async (method, payload, options) => {
        const expected = operations[delivered++];
        if (!expected) throw new Error('Unexpected SSH delivery');
        expect(method).toBe(RPC_METHODS.UI_ACTION_EXECUTE);
        expect(UiActionDispatchRequestV1Schema.parse(payload)).toMatchObject({ actionId: expected.actionId, input: expected.input,
          context: { surface, authority: 'account_automation' } });
        options.onIssued();
        return { ok: true, result: { v: 1, execution: { ok: true, result: expected.result } } };
      },
    };
    const context = { surface, authority: 'account_automation', bypassApprovals: true } as const;
    for (const operation of operations) {
      expect(await executor(client).execute(operation.actionId, operation.input, context)).toEqual({ ok: true, result: operation.result });
      expect(await executor(disconnectedClient).execute(operation.actionId, operation.input, context)).toMatchObject({ ok: false, errorCode: 'unavailable', error: 'noClient' });
    }
    expect(delivered).toBe(operations.length);
    expect((await executor(client).execute('machines.add.ssh.start', operations[0].input, { ...context, surface: 'cli' })).ok).toBe(false);
    expect(delivered).toBe(operations.length);
  });

  it.each(['cli', 'agent', 'mcp'] as const)('delivers Machine metadata to the answering client for %s and refuses a disconnected client', async surface => {
    const input = { serverId: 'home', machineId: 'machine', expectedVersion: 4,
      patch: { displayName: 'New name', windowsRemoteSessionLaunchMode: 'windows_terminal' } };
    const client: ClientActionMachineRpc = {
      hasConnectedClientRpcHandler: method => method === RPC_METHODS.UI_ACTION_EXECUTE,
      callConnectedClientRpc: async (_method, payload, options) => {
        expect(UiActionDispatchRequestV1Schema.parse(payload)).toMatchObject({ actionId: 'machines.metadata.update', input });
        options.onIssued();
        return { ok: true, result: { v: 1, execution: { ok: true, result: { version: 5 } } } };
      },
    };
    const context = { surface, authority: 'account_automation', serverId: 'home' } as const;
    expect(await executor(client).execute('machines.metadata.update', input, context)).toEqual({ ok: true, result: { version: 5 } });
    expect(await executor(disconnectedClient).execute('machines.metadata.update', input, context)).toEqual({ ok: false, errorCode: 'unavailable', error: 'noClient' });
  });

  const reversal = { scope: { serverId: 'home', accountId: 'account' }, beforeVersion: 4, appliedVersion: 5,
    before: { value: 'dark' }, applied: { value: 'light' } };
  it.each([
    { actionId: 'settings.get', input: { anchor: 'appearance.themeMode', includeVersion: true },
      result: { anchor: 'appearance.themeMode', value: 'dark', settingsVersion: 4 } },
    { actionId: 'settings.set', input: { anchor: 'appearance.themeMode', value: 'light', expectedSettingsVersion: 4 },
      result: { anchor: 'appearance.themeMode', value: 'light', settingsVersion: 5 } },
    { actionId: 'settings.set', input: { anchor: 'appearance.themeMode', value: 'light', reversal: { kind: 'capture' } },
      result: { anchor: 'appearance.themeMode', value: 'light', reversal } },
    { actionId: 'settings.set', input: { anchor: 'appearance.themeMode', value: 'dark',
      reversal: { kind: 'restore', ...reversal } }, result: { anchor: 'appearance.themeMode', value: 'dark' } },
  ] as const)('conditional Settings $actionId reaches the answering client without losing its conditions', async request => {
    let deliveries = 0;
    const client: ClientActionMachineRpc = {
      hasConnectedClientRpcHandler: method => method === RPC_METHODS.UI_ACTION_EXECUTE,
      // Machine RPC is the boundary: this is the admitted answering App's typed result.
      callConnectedClientRpc: async (_method, payload, options) => {
        expect(UiActionDispatchRequestV1Schema.parse(payload)).toMatchObject({ actionId: request.actionId, input: request.input });
        options.onIssued(); ++deliveries;
        return { ok: true, result: { v: 1, execution: { ok: true, result: request.result } } };
      },
    };
    const context = { surface: 'cli', authority: 'present_user', presentUserConfirmation: { actionId: request.actionId } } as const;
    expect(await executor(client).execute(request.actionId, request.input, context)).toEqual({ ok: true, result: request.result });
    expect(deliveries).toBe(1);
    expect(await executor(disconnectedClient).execute(request.actionId, request.input, context)).toMatchObject(
      { ok: false, errorCode: 'unavailable', details: { reason: 'client_unavailable', recovery: { kind: 'connect_client' } } });
    expect(await executor(client).execute('settings.get', { anchor: 'delegation.workDepthLimit' }, { surface: 'cli' }))
      .toMatchObject({ ok: false, errorCode: 'not_authenticated' });
    expect(deliveries).toBe(1);
  });

  it('conditional Settings refuses a malformed issued receipt without an ordinary headless fallback', async () => {
    let deliveries = 0;
    const client: ClientActionMachineRpc = {
      hasConnectedClientRpcHandler: () => true,
      callConnectedClientRpc: async (_method, _payload, options) => {
        options.onIssued(); ++deliveries;
        return { ok: true, result: { v: 1, execution: { ok: true, result: {
          anchor: 'appearance.themeMode', value: 'light', reversal: { ...reversal, appliedVersion: 4 },
        } } } };
      },
    };
    expect(await executor(client).execute('settings.set', { anchor: 'appearance.themeMode', value: 'light', reversal: { kind: 'capture' } },
      { surface: 'cli', authority: 'present_user', presentUserConfirmation: { actionId: 'settings.set' } }))
      .toMatchObject({ ok: false, errorCode: 'outcome_uncertain' });
    expect(deliveries).toBe(1);
  });
  it('projects live plugin caller provenance without sending process-local occurrence metadata', async () => {
    const sourceCustody = { kind: 'development', registeredRootId: 'settings-probe-root' } as const;
    const actionCaller = {
      kind: 'plugin', pluginId: 'example.settings-probe', contributionLocalId: 'inspect', sourceCustody,
      occurrenceId: 'live-occurrence', initiatingCaller: { kind: 'host' },
    } as const;
    const dispatch = createClientActionReverseDispatcher(() => ({
      hasConnectedClientRpcHandler: () => true,
      callConnectedClientRpc: async (_method, payload, options) => {
        expect(UiActionDispatchRequestV1Schema.parse(payload).context.actionCaller).toEqual({
          kind: 'plugin', pluginId: 'example.settings-probe', contributionLocalId: 'inspect', sourceCustody, startedBy: 'user',
        });
        options.onIssued();
        return { ok: true, result: { v: 1, execution: { ok: true, result: { anchor: 'appearance.themeMode', value: 'dark' } } } };
      },
    }));
    expect(await dispatch({ actionId: 'settings.get', input: { anchor: 'appearance.themeMode' }, context: {
      surface: 'cli', authority: 'account_automation', actionCaller,
    } })).toEqual({ ok: true, result: { anchor: 'appearance.themeMode', value: 'dark' } });
  });
  it('reads a device setting through the answering client and gives actionable absence', async () => {
    const result = { anchor: 'appearance.themeMode', value: 'dark' };
    const client: ClientActionMachineRpc = {
      hasConnectedClientRpcHandler: method => method === RPC_METHODS.UI_ACTION_EXECUTE,
      callConnectedClientRpc: async (_method, payload, options) => {
        expect(UiActionDispatchRequestV1Schema.parse(payload)).toMatchObject({ actionId: 'settings.get', input: { anchor: 'appearance.themeMode' } });
        options.onIssued();
        return { ok: true, result: { v: 1, execution: { ok: true, result } } };
      },
    };
    expect(await executor(client).execute('settings.get', { anchor: 'appearance.themeMode' }, { surface: 'cli', authority: 'present_user' }))
      .toEqual({ ok: true, result });
    expect(await executor(disconnectedClient).execute('settings.get', { anchor: 'appearance.themeMode' }, { surface: 'cli' }))
      .toMatchObject({ ok: false, errorCode: 'unavailable', error: 'noClient', details: {
        reason: 'client_unavailable', recovery: { kind: 'connect_client', rpcMethod: RPC_METHODS.UI_ACTION_EXECUTE },
      } });
  });
  it('opens an editable authoring draft through the answering client and returns typed absence when it is disconnected', async () => {
    const actionId = ActionIdSchema.parse('session.authoring.open');
    const input = { seed: { prompt: 'Help me author this checkout.', placement: {
      kind: 'exactTarget', serverId: 'home', machineId: 'machine', directory: '/checkout',
    } } };
    const client: ClientActionMachineRpc = {
      hasConnectedClientRpcHandler: method => method === RPC_METHODS.UI_ACTION_EXECUTE,
      callConnectedClientRpc: async (_method, payload, options) => {
        expect(UiActionDispatchRequestV1Schema.parse(payload)).toMatchObject({ actionId, input });
        options.onIssued();
        return { ok: true, result: { v: 1, execution: { ok: true, result: {
          kind: 'opened', draftId: 'draft', destination: 'newSession',
        } } } };
      },
    };
    const context = { surface: 'cli', authority: 'present_user' } as const;
    await expect(executor(client).execute(actionId, input, context)).resolves.toEqual({ ok: true, result: {
      kind: 'opened', draftId: 'draft', destination: 'newSession',
    } });
    await expect(executor(disconnectedClient).execute(actionId, input, context)).resolves.toEqual({ ok: true, result: {
      kind: 'unavailable', reason: 'client_unavailable',
    } });
  });
  it('delivers configured Companion input reads through the admitted client transport and refuses headless delivery', async () => {
    const surface = { serverId: 'home', accountId: 'account', owner: { kind: 'companion', sessionId: 'session' } } as const;
    const ref = { surface, instanceId: 'checks' };
    const bindings = { count: { kind: 'value', value: 7 } } as const;
    const client: ClientActionMachineRpc = {
      hasConnectedClientRpcHandler: method => method === RPC_METHODS.UI_ACTION_EXECUTE,
      callConnectedClientRpc: async (_method, payload, options) => {
        const request = UiActionDispatchRequestV1Schema.parse(payload);
        expect(request).toMatchObject({ actionId: 'widgets.item.inputs.get', input: { ref } });
        options.onIssued();
        return { ok: true, result: { v: 1, execution: { ok: true, result: { ref, bindings } } } };
      },
    };
    const context = { surface: 'agent', defaultSessionId: 'session', serverId: 'home' } as const;
    await expect(executor(client).execute('widgets.item.inputs.get', { ref }, context))
      .resolves.toEqual({ ok: true, result: { ref, bindings } });
    await expect(executor(disconnectedClient).execute('widgets.item.inputs.get', { ref }, context))
      .resolves.toEqual({ ok: false, errorCode: 'unavailable', error: 'noClient' });
    expect(UiActionDispatchRequestV1Schema.safeParse({ v: 1, actionId: 'widgets.item.inputs.get',
      input: { ref: { ...ref, surface: { ...surface, owner: { kind: 'home' } } } },
      context: { surface: 'agent', authority: 'account_automation' } }).success).toBe(false);
  });
  it.each([
    ['ui.find', { op: 'read' }, { ok: true, result: { status: 'unavailable', reason: 'noClient' } }],
    ['session.pending.next', {}, { ok: true, result: { status: 'unavailable' } }],
    ['workspace.tabs.list', {}, { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:workspace.tabs.list' }],
  ] as const)('returns typed absence for %s with an older or disconnected app', async (actionId, input, result) => {
    await expect(executor({ hasConnectedClientRpcHandler: () => false,
      callConnectedClientRpc: async () => { throw new Error('must not issue'); },
    }).execute(actionId, input, { surface: 'mcp', authority: 'account_automation' })).resolves.toEqual(result);
  });

  it.each(['lost', 'malformed'] as const)('never retries an issued %s result', async disposition => {
    let effects = 0;
    const client: ClientActionMachineRpc = {
      hasConnectedClientRpcHandler: method => method === RPC_METHODS.UI_ACTION_EXECUTE,
      callConnectedClientRpc: async (_method, _request, options) => {
        expect(options.timeoutMs).toBe(null);
        options.onIssued(); effects++;
        if (disposition === 'lost') throw new Error('connection lost');
        return { ok: true, result: { v: 1, execution: { ok: true, result: { status: 'idle', privateText: 'secret' } } } };
      },
    };
    await expect(executor(client).execute('ui.find', { op: 'read' }, { surface: 'agent' }))
      .resolves.toEqual({ ok: false, errorCode: 'outcome_uncertain', error: 'outcome_uncertain' });
    expect(effects).toBe(1);
  });

  it('accepts method disappearance before execution as absence, not a successful effect', async () => {
    const client: ClientActionMachineRpc = {
      hasConnectedClientRpcHandler: () => true,
      callConnectedClientRpc: async (_method, _params, options) => {
        options.onIssued();
        return { ok: false, errorCode: 'RPC_METHOD_NOT_AVAILABLE' };
      },
    };
    await expect(executor(client).execute('workspace.tabs.list', {}, { surface: 'agent' }))
      .resolves.toEqual({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:workspace.tabs.list' });
  });
});
