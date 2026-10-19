import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { ApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';

import {
  formatQualifiedPluginActionId,
  getActionSpec,
  type ActionDefinitionV1,
} from '@happier-dev/protocol';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { createVoiceToolHandlers, resolveVoiceToolEffectClass } = await import('./handlers');
const { resolveVoiceActionExecution } = await import('./voiceActionExecution');

describe('Voice Action reference catalog', () => {
  beforeEach(async () => { await home.reset(); });
  afterEach(async () => { await home.reset(); });
  it.each([
    ['follow.get', { receiver: { kind: 'account' }, source: { kind: 'session', sessionId: 'exact-source' } }],
    ['follow.set', { receiver: { kind: 'session', sessionId: { selector: 'self' } }, source: { kind: 'session', sessionId: 'exact-source' }, policy: { preset: 'important' } }],
    ['follow.remove', { receiver: { kind: 'account' }, source: { kind: 'session', sessionId: 'exact-source' } }],
    ['follow.list', { direction: 'following', receiver: { kind: 'account' } }],
    ['follow.preview', { receiver: { kind: 'account' }, filter: {
      show: 'sessions', startedBy: ['you'], scope: 'all_accessible', attention: 'any',
      homeServerIds: ['home'], audiences: [], tagIds: [], source: 'all',
    } }],
    ['follow.preferences.get', {}],
    ['follow.preferences.set', { assigned: true, direct: false, team: false, group: false }],
    ['session.message.reply', { sessionId: { selector: 'self' }, requestLocalId: 'original-input', reply: { kind: 'pass' } }],
    ['session.handoff', { sessionId: 'exact-session', targetMachineId: 'exact-machine', stateTransfer: 'existing', workspaceAction: { kind: 'none' } }],
    ['session.update.post', { summary: 'A persisted update' }],
    ['inbox.get', {}],
    ['inbox.mark_all_read', { targets: [] }],
    ['session.trigger.list', { sessionId: 'exact-session' }],
    ['workflow.trigger.list', { workflow: 'builtin:review-and-converge' }],
    ['workflow.run.list', { targetSessionId: 'exact-session' }],
    ['session.read_state.set', { sessionId: 'exact-session', state: 'read' }],
    ['session.attention.set', { sessionId: 'exact-session', standing: false }],
    ['session.manager.set', { sessionId: 'exact-worker', managerSessionId: 'exact-manager', expectedManagerSessionId: null }],
  ] as const)('resolves generic Voice execution of %s without changing its exact operands', (actionId, input) => {
    const resolved = resolveVoiceActionExecution({ actionId, input });
    expect(resolved?.spec.id).toBe(actionId);
    expect(resolved?.input).toEqual(input);
    expect(resolved?.toolName).toBe(actionId.replaceAll('.', '_'));
    const handlers = createVoiceToolHandlers({ resolveSessionId: () => null });
    expect(handlers[actionId.replaceAll('.', '_')]).toBeTypeOf('function');
  });
  it.each([
    { managerSessionId: 'exact-manager', expectedManagerSessionId: null },
    { managerSessionId: null, expectedManagerSessionId: 'exact-manager' },
  ])('retains manager Voice operands and approval before attachment changes ($managerSessionId)', async operands => {
    const serverUrl = 'https://manager-voice.test';
    const serverId = await home.addHome({ name: 'Manager Home', serverUrl, accountId: 'account-a', currentAccount: true });
    const connection = await restoreServerAccountForTest({ serverUrl, accountId: 'account-a',
      credentials: { token: createAccountTokenForTests('account-a', { currentAccount: true }) },
      request: (url, init) => home.request(url, init) });
    try {
      await home.requireActionApproval(serverId, 'session.manager.set', 'voice');
      const handlers = createVoiceToolHandlers({ resolveSessionId: () => null });
      expect(resolveVoiceToolEffectClass('session_manager_set')).toBe('mutation');
      const input = { sessionId: 'exact-worker', ...operands };
      const result = JSON.parse(await handlers.action_execute!({ actionId: 'session.manager.set', input }, {
        serverId, effectId: operands.managerSessionId === null ? 'voice-manager-detach' : 'voice-manager-attach',
      }));
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      const approvals = home.artifacts(serverId).list().map(row => ApprovalRequestSchema.parse(
        JSON.parse(home.artifacts(serverId).readPlainBody(row.id) ?? 'null'),
      ));
      expect(approvals).toEqual([expect.objectContaining({ actionId: 'session.manager.set', actionArgs: input, status: 'open' })]);
      expect(home.requests.filter(request => request.path === '/v1/sessions/exact-worker/manager')).toEqual([]);
    } finally {
      await connection.dispose();
      installHomeGovernanceBoundaries(home);
    }
  });
  it.each(['session.read_state.set', 'session.attention.set'] as const)(
    'dispatches %s from Voice with private Account authority and exact Home', async actionId => {
      const serverUrl = 'https://attention-voice.test';
      const serverId = await home.addHome({ name: 'Attention Home', serverUrl, accountId: 'account-a', currentAccount: true });
      const path = actionId === 'session.read_state.set'
        ? '/v2/sessions/exact-session/read-state'
        : '/v2/session-organization/attention-standings/exact-session';
      const method = actionId === 'session.read_state.set' ? 'POST' : 'PUT';
      const body = actionId === 'session.read_state.set' ? { state: 'read' } : { standing: false };
      home.answer(serverId, `${method} ${path}`, { body: actionId === 'session.read_state.set'
        ? { success: true, state: 'read', lastViewedSessionSeq: 7, didChange: true }
        : { standing: { sessionId: 'exact-session', standing: false, updatedAt: 10 } } });
      const connection = await restoreServerAccountForTest({ serverUrl, accountId: 'account-a',
        credentials: { token: createAccountTokenForTests('account-a', { currentAccount: true }) },
        request: (url, init) => home.request(url, init) });
      try {
        const handlers = createVoiceToolHandlers({ resolveSessionId: () => null });
        const handler = handlers.action_execute;
        expect(handler).toBeTypeOf('function');
        const result = JSON.parse(await handler!({ actionId, input: { sessionId: 'exact-session', ...body } }, { serverId }));
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
        const request = home.requests.find(request => request.path === path);
        expect(request).toMatchObject({ serverId, input: body, token: connection.credentials.token });
        expect(getActionSpec(actionId).requiredAuthority).toBe('account_automation');
      } finally {
        await connection.dispose();
        installHomeGovernanceBoundaries(home);
      }
    });
  it('routes Workflow start Voice input through the canonical Action schema and mutation custody', async () => {
    const serverId = await home.addHome({ name: 'Workflow Home', serverUrl: 'https://workflow-voice.test', accountId: 'account-a', currentAccount: true });
    const handlers = createVoiceToolHandlers({ resolveSessionId: () => null });
    const handler = handlers.workflow_run_start;
    expect(handler).toBeTypeOf('function');
    expect(resolveVoiceToolEffectClass('workflow_run_start')).toBe('mutation');
    expect(JSON.parse(await handler!({ runId: 'not-a-uuid', source: {} }, { effectId: 'voice-workflow-start', serverId })))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
  });
  it.each(['localServices_actions_copyUrl'] as const)(
    'does not advertise %s when the permission receipt has no answering clipboard or navigation client', toolName => {
      const handlers = createVoiceToolHandlers({ resolveSessionId: () => null });
      expect(handlers[toolName]).toBeUndefined();
    });
  it.each(['localServices_launcher_start', 'localServices_actions_stopManaged', 'localServices_actions_openPreview'] as const)(
    'routes %s through the actual Action input boundary and retains mutation custody classification', async toolName => {
      // The front door captures an actual signed-in Home before dispatch.
      // Seed its credential/network boundaries, not an internal executor.
      const serverId = await home.addHome({ name: 'Service Home', serverUrl: 'https://service-home.test', accountId: 'account-a', currentAccount: true });
      const handlers = createVoiceToolHandlers({ resolveSessionId: () => null });
      const handler = handlers[toolName];
      expect(handler).toBeTypeOf('function');
      expect(resolveVoiceToolEffectClass(toolName)).toBe('mutation');
      // No internal Action executor replacement: invalid semantic input must
      // settle before a Machine effect can occur, even without a selected Session.
      expect(JSON.parse(await handler!({}, { effectId: 'voice-service-effect', serverId })))
        .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    });
  it('composes current contributed Actions into the existing action.spec tools', async () => {
    const contributedAction: ActionDefinitionV1 = {
      kindVersion: 1,
      id: formatQualifiedPluginActionId({ pluginId: 'acme.triage', localId: 'file-ticket' }),
      title: 'File ticket',
      description: 'Files a ticket for the selected issue.',
      safety: 'safe',
      approval: { result: 'none' },
      placements: [],
      slash: null,
      bindings: null,
      examples: null,
      surfaces: {
        ui: false,
        voice: true,
        agent: false,
        mcp: false,
        cli: false,
        rpc: false,
        api: false,
        plugin: false,
      },
      inputHints: null,
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    };
    const handlers = createVoiceToolHandlers({
      resolveSessionId: () => null,
      currentUiContext: {
        readCurrentUiContext: () => null,
        resolveCurrentUiCommand: () => null,
        subscribe: () => () => undefined,
        listCurrentContributedActionDefinitions: () => [contributedAction],
      },
    });
    const searchToolName = getActionSpec('action.spec.search').bindings?.voiceClientToolName;
    if (!searchToolName) throw new Error('missing action.spec.search Voice binding');

    const result = JSON.parse(await handlers[searchToolName]!({ query: 'file ticket' }));

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.actionSpecs).toContainEqual(expect.objectContaining({
      id: contributedAction.id,
      title: contributedAction.title,
    }));
  });
});
