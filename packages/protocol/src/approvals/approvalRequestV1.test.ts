import { describe, expect, it } from 'vitest';

import { ActionIdSchema } from '../actions/actionIds.js';
import { getActionSpec } from '../actions/actionSpecs.js';
import {
  ApprovalRequestSchema,
  ApprovalExecutionOriginV1Schema,
  ApprovalRequestV1Schema,
  ApprovalRequestV2Schema,
  StoredApprovalRequestSchema,
  requiresExactDaemonApprovalReplay,
} from './approvalRequestV1.js';
import { projectApprovalExecutionFailureV2, readApprovalExecutionFailure } from './approvalExecutionFailure.js';
import { ManagedResourceDependencyV1Schema } from '../machines/managed/managedDependencyV1.js';
import { parseSessionBoardActionPortResultV1 } from '../sessions/board/actions.js';
import { API_TOKEN_FULL_GRANT_V1 } from '../auth/apiTokenGrant.js';
import { SessionActionRpcOriginV1Schema } from '../rpc/socket.js';
import { buildApprovalExecutionOriginV1 } from '../actions/actionExecutor.js';
import { signExternalActionApprovalInputV1 } from '../actions/externalActionExecutionAuthorization.js';
import tweetnacl from 'tweetnacl';

it('replays only host-caused authenticated Home continuation requests at the deciding client', () => {
  const actionId = 'account.home_continuation.invoke';
  const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
    createdBy: { surface: 'agent' }, requestedSurface: 'agent', actionId,
    actionArgs: { operation: 'refresh', commandId: 'current-ui:home' }, summary: 'Refresh Homes',
    executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', caller: { kind: 'host' },
      serverId: 'home', accountId: 'alice', actionId, requestId: 'request-home' } });
  for (const surface of ['agent', 'mcp'] as const) {
    expect(requiresExactDaemonApprovalReplay(ApprovalRequestV2Schema.parse({ ...request,
      createdBy: { surface }, requestedSurface: surface,
      executionOriginV1: { ...request.executionOriginV1, surface } }))).toBe(false);
  }
  for (const caller of [
    { kind: 'session', sessionId: 'source', starterDepth: 0, turnDepth: 0 },
    { kind: 'plugin', pluginId: 'custom.owner', contributionLocalId: 'step',
      sourceCustody: { kind: 'managed', immutableGenerationId: 'generation', installSource: 'archive' } },
  ] as const) {
    expect(requiresExactDaemonApprovalReplay(ApprovalRequestV2Schema.parse({ ...request,
      executionOriginV1: { ...request.executionOriginV1, caller } }))).toBe(true);
  }
  expect(requiresExactDaemonApprovalReplay(ApprovalRequestV2Schema.parse({ ...request, actionId: 'ui.current_context.command.invoke',
    actionArgs: { commandId: 'current-ui:home' },
    executionOriginV1: { ...request.executionOriginV1, actionId: 'ui.current_context.command.invoke' } }))).toBe(true);
});

it('retains genuine signed Account approval origins without replacing Session automation with present-user authority', () => {
  const target = { kind: 'machine' as const, machineId: 'controller' };
  const binding = { accountId: 'requester', authentication: { kind: 'account' as const, tokenEpoch: 7 },
    serverIdentityId: 'srv_home', machineId: 'controller', custodianAccountId: 'requester', installationId: 'installation',
    actionId: 'machines.managed.acquire', requestId: 'original-request', requestEnvelopeDigest: 'a'.repeat(43), target };
  const ui = { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' }, serverId: 'local-profile',
    serverIdentityId: 'srv_home', accountId: 'requester', machineId: 'controller', actionId: 'machines.managed.acquire',
    requestId: 'original-request', target, externalActionInputSignature: 'a'.repeat(86),
    externalActionExecutionAuthorization: { v: 1, token: 'home-signed', binding } } as const;
  const signingKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)).secretKey;
  const context = { serverId: 'local-profile', serverIdentityId: 'srv_home', runtimeAccountId: 'requester',
    actionRequestId: 'original-request', externalActionTarget: target,
    externalActionExecutionAuthorization: { v: 1 as const, token: 'home-signed', binding },
    signExternalActionApprovalInput: (request: Parameters<NonNullable<import('../actions/executor/types.js').ActionExecutorContext['signExternalActionApprovalInput']>>[0]) =>
      signExternalActionApprovalInputV1({ actionId: request.actionId, input: request.input, target: request.target,
        authorizationToken: request.authorization.token, privateKey: signingKey }) };
  expect(buildApprovalExecutionOriginV1({ actionId: 'machines.managed.acquire', input: {}, targetSessionId: null,
    context: { ...context, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } }))
    .toMatchObject({ authority: 'present_user', surface: 'ui', caller: { kind: 'host' }, accountId: 'requester' });
  expect(ApprovalExecutionOriginV1Schema.parse(ui)).toEqual(ui);
  const pluginCaller = { kind: 'plugin' as const, pluginId: 'happier.inspector', contributionLocalId: 'inspector-app',
    sourceCustody: { kind: 'development' as const, registeredRootId: 'inspector-root' } };
  const plugin = { ...ui, surface: 'plugin' as const, caller: pluginCaller };
  expect(buildApprovalExecutionOriginV1({ actionId: 'machines.managed.acquire', input: {}, targetSessionId: null,
    context: { ...context, surface: 'plugin', authority: 'present_user', actionCaller: {
      ...pluginCaller, occurrenceId: 'current-occurrence',
    } } })).toMatchObject({ authority: 'present_user', surface: 'plugin', caller: pluginCaller });
  expect(ApprovalExecutionOriginV1Schema.parse(plugin)).toEqual(plugin);
  expect(ApprovalExecutionOriginV1Schema.safeParse({ ...plugin, surface: 'ui' }).success).toBe(false);
  expect(ApprovalExecutionOriginV1Schema.safeParse({ ...plugin, caller: { kind: 'host' } }).success).toBe(false);
  expect(ApprovalExecutionOriginV1Schema.safeParse({ ...plugin, caller: { ...pluginCaller, sourceCustody: undefined } }).success).toBe(false);
  expect(requiresExactDaemonApprovalReplay(ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
    createdBy: { surface: 'system' }, requestedSurface: 'ui', actionId: ui.actionId, actionArgs: {}, summary: 'Acquire Machine',
    executionOriginV1: ui }))).toBe(true);
  for (const changed of [
    { serverIdentityId: 'srv_other' }, { accountId: 'other-requester' }, { machineId: 'other-machine' },
    { requestId: 'different-request' }, { target: { kind: 'machine', machineId: 'other-machine' } },
  ]) expect(ApprovalExecutionOriginV1Schema.safeParse({ ...ui, ...changed }).success).toBe(false);
  const sessionActionOrigin = SessionActionRpcOriginV1Schema.parse({ v: 1,
    caller: { kind: 'session', sessionId: 'source', starterDepth: 1, turnDepth: 2 }, sourceTurnId: 'turn',
    callerPermissionMode: 'read-only', causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' },
    workspaceWrites: 'deny', requestId: 'original-request' });
  const session = { ...ui, authority: 'account_automation', surface: 'agent', caller: sessionActionOrigin.caller,
    callerPermissionMode: sessionActionOrigin.callerPermissionMode, causalPermissionAuthority: sessionActionOrigin.causalPermissionAuthority,
    sessionInputSource: { sourceSessionId: 'source', sourceTurnId: 'turn', via: 'action' },
    externalActionExecutionAuthorization: { ...ui.externalActionExecutionAuthorization,
      binding: { ...binding, sessionActionOrigin, sessionActionSource: { machineId: 'controller', installationId: 'installation' } } } };
  expect(buildApprovalExecutionOriginV1({ actionId: 'machines.managed.acquire', input: {}, targetSessionId: null,
    context: { ...context, surface: 'agent', authority: 'account_automation', actionCaller: sessionActionOrigin.caller,
      callerPermissionMode: sessionActionOrigin.callerPermissionMode, causalPermissionAuthority: sessionActionOrigin.causalPermissionAuthority,
      workspaceWrites: 'deny',
      sessionInputSource: { sourceSessionId: 'source', sourceTurnId: 'turn', via: 'action' },
      externalActionExecutionAuthorization: session.externalActionExecutionAuthorization,
    } }))
    .toMatchObject({ authority: 'account_automation', surface: 'agent', caller: sessionActionOrigin.caller,
      callerPermissionMode: 'read-only', causalPermissionAuthority: sessionActionOrigin.causalPermissionAuthority });
  expect(ApprovalExecutionOriginV1Schema.parse(session)).toEqual(session);
  for (const changed of [
    { authority: 'present_user' }, { surface: 'ui' }, { caller: { ...sessionActionOrigin.caller, turnDepth: 0 } },
    { callerPermissionMode: 'yolo' }, { causalPermissionAuthority: null }, { requestId: 'different-request' },
    { sessionInputSource: { sourceSessionId: 'other-source', sourceTurnId: 'turn', via: 'action' } },
    { sessionInputSource: { sourceSessionId: 'source', sourceTurnId: 'other-turn', via: 'action' } },
    { principalId: 'fake-pat', credentialId: 'fake-pat' },
  ]) expect(ApprovalExecutionOriginV1Schema.safeParse({ ...session, ...changed }).success).toBe(false);
  expect(buildApprovalExecutionOriginV1({ actionId: 'machines.managed.acquire', input: {}, targetSessionId: null,
    context: { ...context, surface: 'agent', authority: 'account_automation', actionCaller: sessionActionOrigin.caller,
      callerPermissionMode: sessionActionOrigin.callerPermissionMode, causalPermissionAuthority: sessionActionOrigin.causalPermissionAuthority,
      workspaceWrites: 'allow', sessionInputSource: { sourceSessionId: 'source', sourceTurnId: 'turn', via: 'action' },
      externalActionExecutionAuthorization: session.externalActionExecutionAuthorization,
    } })).toBeNull();
  const automatedUi = { ...ui, authority: 'account_automation' } as const;
  expect(ApprovalExecutionOriginV1Schema.parse(automatedUi)).toEqual(automatedUi);
  expect(buildApprovalExecutionOriginV1({ actionId: 'machines.managed.acquire', input: {}, targetSessionId: null,
    context: { ...context, surface: 'ui', authority: 'account_automation', actionCaller: { kind: 'host' } } }))
    .toMatchObject({ authority: 'account_automation', surface: 'ui', accountId: 'requester' });
  const pairedTerminal = { ...automatedUi, externalActionExecutionAuthorization: {
    ...automatedUi.externalActionExecutionAuthorization,
    binding: { ...binding, authentication: { kind: 'terminal' as const, tokenEpoch: 7 } },
  } };
  expect(ApprovalExecutionOriginV1Schema.safeParse(pairedTerminal).success).toBe(true);
  expect(buildApprovalExecutionOriginV1({ actionId: 'machines.managed.acquire', input: {}, targetSessionId: null,
    context: { ...context, surface: 'ui', authority: 'account_automation', actionCaller: { kind: 'host' },
      externalActionExecutionAuthorization: pairedTerminal.externalActionExecutionAuthorization } }))
    .toMatchObject({ authority: 'account_automation', surface: 'ui', accountId: 'requester' });
  expect(buildApprovalExecutionOriginV1({ actionId: 'machines.managed.acquire', input: {}, targetSessionId: null,
    context: { ...context, surface: 'cli', authority: 'account_automation', actionCaller: { kind: 'host' },
      externalActionExecutionAuthorization: pairedTerminal.externalActionExecutionAuthorization } }))
    .toMatchObject({ authority: 'account_automation', surface: 'cli', accountId: 'requester' });
  for (const changed of [{ surface: 'voice' }, { accountId: 'other-requester' }, { requestId: 'different-request' }]) {
    expect(ApprovalExecutionOriginV1Schema.safeParse({ ...automatedUi, ...changed }).success).toBe(false);
  }
});

describe('ApprovalRequestV1Schema', () => {
  it.each([
    ['machines.presets.create', { kind: 'refused', code: 'provider_unavailable' }, 'provider_unavailable'],
    ['machines.presets.update', { kind: 'conflict', currentRevision: 4 }, 'conflict'],
    ['machines.managed.power.set', { kind: 'refused', code: 'provider_unavailable' }, 'provider_unavailable'],
    ['machines.managed.rebuild', { kind: 'conflict', currentRevision: 4 }, 'intent_changed'],
    ['machines.pools.resolve', { kind: 'unavailable', poolId: '123e4567-e89b-42d3-a456-426614174000', reason: 'presence_unavailable' }, 'presence_unavailable'],
    ['machines.worker.policy.set', { status: 'conflict', policy: { accepting: false, runAtMost: null }, metadataVersion: 4 }, 'conflict'],
    ['projects.worker.preferences.set', { status: 'outcomeUnknown' }, 'outcomeUnknown'],
    ['projects.worker.preferences.reset', { status: 'locked' }, 'locked'],
    ['projects.service.placement.set', { status: 'unavailable' }, 'unavailable'],
    ['action.operations.cancel', { kind: 'unsupported' }, 'unsupported'],
    ['action.operations.cancel', { kind: 'not_found' }, 'not_found'],
  ] as const)('reads a typed unsuccessful domain result from executed %s history', (actionId, result, errorCode) => {
    const request = ApprovalRequestV1Schema.parse({ v: 1, status: 'executed', createdAtMs: 1, updatedAtMs: 3,
      createdBy: { surface: 'system' }, actionId, actionArgs: {}, summary: 'Machine action',
      decision: { kind: 'approve', decidedAtMs: 2 }, execution: { executedAtMs: 3, ok: true, result } });
    expect(readApprovalExecutionFailure(request)).toMatchObject({ ok: false, errorCode, details: result });
    expect(readApprovalExecutionFailure({ ...request, execution: { ...request.execution!, result: { ...result, future: true } } }))
      .toEqual({ ok: false, errorCode, error: errorCode, details: result });
  });

  it('does not interpret arbitrary Action data as a machine refusal or trust malformed typed results', () => {
    const request = ApprovalRequestV1Schema.parse({ v: 1, status: 'executed', createdAtMs: 1, updatedAtMs: 3,
      createdBy: { surface: 'system' }, actionId: 'settings.get', actionArgs: {}, summary: 'Read setting',
      decision: { kind: 'approve', decidedAtMs: 2 }, execution: { executedAtMs: 3, ok: true,
        result: { kind: 'refused', code: 'provider_unavailable' } } });
    expect(readApprovalExecutionFailure(request)).toBeNull();
    expect(readApprovalExecutionFailure({ ...request, actionId: 'machines.presets.list',
      execution: { ...request.execution!, result: { kind: 'listed', presets: [] } } })).toBeNull();
    expect(readApprovalExecutionFailure({ ...request, actionId: 'machines.presets.create',
      execution: { ...request.execution!, result: { kind: 'refused', code: 'invented_code' } } }))
      .toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
    for (const status of ['applied', 'satisfied', 'unchanged']) {
      expect(readApprovalExecutionFailure({ ...request, actionId: 'machines.worker.policy.set',
        execution: { ...request.execution!, result: { status, policy: { accepting: true, runAtMost: null }, metadataVersion: 4 } } })).toBeNull();
    }
    expect(readApprovalExecutionFailure({ ...request, actionId: 'projects.worker.preferences.get',
      execution: { ...request.execution!, result: { status: 'unavailable' } } })).toBeNull();
    expect(readApprovalExecutionFailure({ ...request, actionId: 'projects.worker.status',
      execution: { ...request.execution!, result: { eligible: false } } })).toBeNull();
    for (const kind of ['requested', 'already_settled']) {
      expect(readApprovalExecutionFailure({ ...request, actionId: 'action.operations.cancel',
        execution: { ...request.execution!, result: { kind } } })).toBeNull();
    }
    expect(readApprovalExecutionFailure({ ...request, actionId: 'action.operations.get',
      execution: { ...request.execution!, result: { kind: 'not_found' } } })).toBeNull();
  });

  it('retains the bounded Account Settings validator reason without persisting opaque details', () => {
    const actionId = 'settings.set';
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'system' }, requestedSurface: 'cli', actionId,
      actionArgs: { anchor: 'delegation.workDepthLimit', value: 4 }, summary: 'Change depth',
      executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
        serverId: 'home-1', accountId: 'account-1', machineId: 'machine-1', actionId, requestId: 'request-1' } });
    const details = { status: 'invalid', reason: 'invalidValue' };
    const failure = { ok: false as const, errorCode: 'account_settings_invalid', error: 'account_settings_invalid', details };
    const execution = projectApprovalExecutionFailureV2({ request, failure, executedAtMs: 3 });
    expect(execution).toMatchObject({ details });
    const stored = StoredApprovalRequestSchema.parse({ ...request, status: 'failed', updatedAtMs: 3,
      decision: { kind: 'approve', decidedAtMs: 2 }, execution });
    expect(readApprovalExecutionFailure(stored)).toMatchObject({ details });
    for (const unsafe of [{ ...details, token: 'must-not-persist' }, { ...details, reason: 'opaque' }]) {
      expect(projectApprovalExecutionFailureV2({ request, failure: { ...failure, details: unsafe }, executedAtMs: 3 }))
        .not.toHaveProperty('details');
    }
    expect(readApprovalExecutionFailure(StoredApprovalRequestSchema.parse({ ...stored,
      execution: { ...execution, details: { ...details, token: 'must-not-persist' } } }))).toMatchObject({ details });
    expect(projectApprovalExecutionFailureV2({ request: { ...request, actionArgs: {} }, failure, executedAtMs: 3 }))
      .not.toHaveProperty('details');
  });
  it.each(['projects.script.run', 'projects.compute.exec'] as const)(
    'retains only request-bound worker refusal facts for approved %s', actionId => {
      const workspace = { serverId: 'home-1', machineId: 'source', workspaceId: 'source-ref', rootPath: '/source' };
      const actionArgs = actionId === 'projects.script.run'
        ? { workspace, selection: { kind: 'named', name: 'test' } }
        : { workspace, executable: 'make', argv: ['test'], cwd: '/source' };
      const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'system' }, requestedSurface: 'ui', actionId, actionArgs, summary: 'Run project work',
        executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' },
          serverId: 'home-1', accountId: 'account-1', machineId: 'worker', actionId, requestId: 'request-1' } });
      const details = { kind: 'no_worker_can_accept', unavailable: 'primary', reason: 'not_accepting' };
      const failure = { ok: false as const, errorCode: 'not_accepting', error: 'not_accepting', details };
      const execution = projectApprovalExecutionFailureV2({ request, failure, executedAtMs: 3 });
      expect(execution).toMatchObject({ ok: false, errorCode: 'not_accepting', details });
      const stored = StoredApprovalRequestSchema.parse({ ...request, status: 'failed', updatedAtMs: 3,
        decision: { kind: 'approve', decidedAtMs: 2 }, execution });
      expect(readApprovalExecutionFailure(stored)).toMatchObject({ details });
      const extra = { ...details, credential: 'must-not-persist' };
      expect(projectApprovalExecutionFailureV2({ request, failure: { ...failure, details: extra }, executedAtMs: 3 }))
        .not.toHaveProperty('details');
      expect(readApprovalExecutionFailure(StoredApprovalRequestSchema.parse({ ...stored,
        execution: { ...execution, details: extra } }))).toMatchObject({ details });
      for (const invalid of [
        { ...failure, errorCode: 'permission_denied' },
        { ...failure, details: { ...details, reason: 'memory_unavailable' } },
        { ...failure, details: { ...details, unavailable: 'allow' } },
      ]) {
        expect(projectApprovalExecutionFailureV2({ request, failure: invalid, executedAtMs: 3 })).not.toHaveProperty('details');
        expect(readApprovalExecutionFailure(StoredApprovalRequestSchema.parse({ ...stored,
          execution: { executedAtMs: 3, ...invalid } }))).not.toHaveProperty('details');
      }
      for (const invalidArgs of [{}, { ...actionArgs, workspace: { ...workspace, serverId: 'different-home' } }]) {
        expect(projectApprovalExecutionFailureV2({ request: { ...request, actionArgs: invalidArgs }, failure, executedAtMs: 3 }))
          .not.toHaveProperty('details');
        expect(readApprovalExecutionFailure(StoredApprovalRequestSchema.parse({ ...stored, actionArgs: invalidArgs })))
          .not.toHaveProperty('details');
      }
    });
  it.each([
    { actionId: 'secrets.shared.delete', actionArgs: { resourceId: 'secret-1', expectedRevision: 3, expectedSettingsVersion: 1,
      referenceCensus: { accountMode: 'plain', profiles: { referenceGuardRevision: 'absent', rows: [] } } },
      code: 'managed_resources_review_required' },
    { actionId: 'home.accounts.delete', actionArgs: { accountId: 'account-to-delete' },
      code: 'account_erasure_managed_resources_review_required' },
  ] as const)('retains only the strict native removal review for approved $actionId', ({ actionId, actionArgs, code }) => {
    const provider = { pluginId: 'custom.compute', localId: 'vm' };
    const resource = ManagedResourceDependencyV1Schema.parse({ managedId: 'managed-1', homeId: 'home-1',
      custodianAccountId: 'account-1', intentRevision: 7,
      controller: { machineId: 'controller-1', installationId: 'installation-1' }, provider, allocation: 'may-exist',
      resource: { contributionRef: provider, schemaVersion: 1, value: { nativeId: 'native-1' } },
      recovery: { reference: 'native-1', reason: 'response_lost' } });
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'system' }, requestedSurface: 'ui', actionId, actionArgs, summary: 'Review removal',
      executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' },
        serverId: 'home-1', accountId: 'account-1', actionId, requestId: 'request-1' } });
    const details = { error: code, resources: [resource] };
    const failure = { ok: false as const, errorCode: code, error: code, details };
    const project = (nextFailure: typeof failure) => projectApprovalExecutionFailureV2({ request, failure: nextFailure, executedAtMs: 3 });
    const execution = project(failure);
    expect(execution).toMatchObject({ ok: false, errorCode: code, details });
    const stored = StoredApprovalRequestSchema.parse({ ...request, status: 'failed', updatedAtMs: 3,
      decision: { kind: 'approve', decidedAtMs: 2 }, execution });
    expect(readApprovalExecutionFailure(stored)).toMatchObject({ details });

    for (const unsafeDetails of [
      { ...details, bearer: 'must-not-persist' },
      { ...details, resources: [{ ...resource, credential: 'must-not-persist' }] },
    ]) {
      expect(projectApprovalExecutionFailureV2({ request, failure: { ...failure, details: unsafeDetails }, executedAtMs: 3 })).not.toHaveProperty('details');
      const unsafeStored = StoredApprovalRequestSchema.parse({ ...stored, execution: { ...execution, details: unsafeDetails } });
      expect(readApprovalExecutionFailure(unsafeStored)).toMatchObject({ details });
      expect(JSON.stringify(readApprovalExecutionFailure(unsafeStored))).not.toContain('must-not-persist');
    }
    for (const invalidDetails of [
      { ...details, error: 'permission_denied' },
      { ...details, resources: [{ ...resource, intentRevision: 'invalid' }] },
    ]) {
      expect(projectApprovalExecutionFailureV2({ request, failure: { ...failure, details: invalidDetails }, executedAtMs: 3 })).not.toHaveProperty('details');
      const unsafeStored = StoredApprovalRequestSchema.parse({ ...stored, execution: { ...execution, details: invalidDetails } });
      expect(readApprovalExecutionFailure(unsafeStored)).not.toHaveProperty('details');
    }
    const unrelated = ApprovalRequestV2Schema.parse({ ...request, actionId: 'session.title.set',
      actionArgs: { sessionId: 'session-1', title: 'Title' },
      executionOriginV1: { ...request.executionOriginV1, actionId: 'session.title.set' } });
    expect(projectApprovalExecutionFailureV2({ request: unrelated, failure, executedAtMs: 3 })).not.toHaveProperty('details');
    expect(projectApprovalExecutionFailureV2({ request, failure: { ...failure, errorCode: 'permission_denied' }, executedAtMs: 3 })).not.toHaveProperty('details');
    expect(projectApprovalExecutionFailureV2({ request: { ...request, actionArgs: {} }, failure, executedAtMs: 3 })).not.toHaveProperty('details');
  });

  it('keeps confidential credential approval custody value-free and bound to its admitted Home and target', () => {
    const actionArgs = {
      serverId: 'home-1', sessionId: 'session-1', machineId: 'machine-1', purpose: 'Sign in',
      browserSessionId: 'browser-1', viewId: 'view-1', tabId: 'tab-1', frameId: 'frame-1',
      documentId: 'document-1', navigationGeneration: 1, origin: 'https://example.test',
      field: { fieldId: 'password-1', focusId: 'focus-1', locator: '#password' },
    };
    const actionId = 'browser.automation.secret.fill';
    const request = {
      v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'agent', sessionId: 'session-1' }, requestedSurface: 'agent',
      actionId, actionArgs, summary: 'Sign in',
      preview: { actionId, actionArgs },
      executionOriginV1: {
        v: 1, authority: 'account_automation', surface: 'agent', caller: { kind: 'host' },
        serverId: 'home-1', sessionId: 'session-1', machineId: 'machine-1', actionId, requestId: 'request-1',
      },
    };
    expect(ApprovalRequestV2Schema.safeParse(request).success).toBe(true);
    for (const changed of [
      { actionArgs: { ...actionArgs, value: 'recognizable-private-value' } },
      { preview: { actionId, actionArgs, valueHash: 'recognizable-private-value' } },
      { origin: { kind: 'transcript_tool_call', toolName: 'secret_fill', toolInput: { value: 'recognizable-private-value' } } },
      { actionArgs: { ...actionArgs, serverId: 'other-home' } },
      { actionArgs: { ...actionArgs, machineId: 'other-machine' } },
      { actionArgs: { ...actionArgs, field: { ...actionArgs.field, value: 'recognizable-private-value' } } },
    ]) {
      expect(ApprovalRequestV2Schema.safeParse({ ...request, ...changed }).success).toBe(false);
      expect(StoredApprovalRequestSchema.safeParse({ ...request, ...changed }).success).toBe(false);
    }
    expect(ApprovalRequestV1Schema.safeParse({ ...request, v: 1 }).success).toBe(false);
    const executed = { ...request, status: 'executed', decision: { kind: 'approve', decidedAtMs: 2 },
      execution: { executedAtMs: 3, ok: true, result: { status: 'filled', code: 'filled' } } };
    expect(ApprovalRequestV2Schema.safeParse(executed).success).toBe(true);
    expect(ApprovalRequestV2Schema.safeParse({ ...executed,
      execution: { ...executed.execution, result: { status: 'filled', code: 'filled', length: 12 } } }).success).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse({ ...executed, status: 'failed',
      execution: { executedAtMs: 3, ok: false, error: 'recognizable-private-value' } }).success).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse({ ...executed, status: 'failed',
      execution: { executedAtMs: 3, ok: false, errorCode: 'approval_stale', error: 'approval_stale' } }).success).toBe(true);
    const nativeArgs = {
      serverId: 'home-1', sessionId: 'session-1', machineId: 'machine-1', purpose: 'Sign in',
      sourceId: 'source-1', target: { kind: 'window', displayId: 'display-1', pid: 1, windowId: 2 }, captureId: 'capture-1',
      geometry: { captureWidth: 100, captureHeight: 80, nativeWidth: 100, nativeHeight: 80,
        originX: 0, originY: 0, scaleX: 1, scaleY: 1, crop: { x: 0, y: 0, width: 100, height: 80 } },
      field: { fieldId: 'field-1', focusId: 'focus-1' },
    };
    const native = { ...request, actionId: 'computer.secret.fill', actionArgs: nativeArgs,
      preview: { actionId: 'computer.secret.fill', actionArgs: nativeArgs },
      executionOriginV1: { ...request.executionOriginV1, actionId: 'computer.secret.fill' } };
    expect(ApprovalRequestV2Schema.safeParse(native).success).toBe(true);
    expect(ApprovalRequestV2Schema.safeParse({ ...native, actionArgs: { ...nativeArgs, value: 'recognizable-private-value' } }).success).toBe(false);
  });
  it('accepts target proof only for the two workspace destination producers', () => {
    const proof = {
      v: 1,
      consequences: ['delete_target_only_files_during_exact_mirror'],
      serverId: 'home-1', machineId: 'machine-1', canonicalRoot: '/work/empty',
      rootFingerprint: 'a'.repeat(64), operationId: 'request-1',
    };
    for (const actionId of ['session.handoff', 'workspace.sync.relationship.create', 'session.title.set'] as const) {
      const request = {
        v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'system' }, requestedSurface: 'ui',
        actionId, actionArgs: {}, summary: 'Approve workspace destination',
        executionOriginV1: {
          v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' },
          serverId: 'home-1', actionId, requestId: 'request-1',
        },
        handoffTargetReplacementApproval: proof,
      };
      expect(ApprovalRequestV2Schema.safeParse(request).success, actionId)
        .toBe(actionId !== 'session.title.set');
    }
  });

  it('exposes only strict request-bound Board failure details from current approval artifacts', () => {
    const currentRevision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
    const base = {
      v: 2,
      status: 'failed',
      createdAtMs: 1,
      updatedAtMs: 3,
      createdBy: { surface: 'system' },
      requestedSurface: 'ui',
      actionId: 'session.board.layout.update',
      actionArgs: {
        sessionId: 'session-1',
        expectedLayoutRevision: null,
        operation: { op: 'tab.create', tabId: 'overview', title: 'Overview' },
      },
      summary: 'Create Board view',
      executionOriginV1: {
        v: 1,
        authority: 'present_user',
        surface: 'ui',
        caller: { kind: 'host' },
        serverId: 'home-1',
        accountId: 'account-1',
        sessionId: 'session-1',
        target: { kind: 'session', sessionId: 'session-1' },
        actionId: 'session.board.layout.update',
        requestId: 'request-1',
      },
      decision: { kind: 'approve', decidedAtMs: 2 },
      execution: {
        executedAtMs: 3,
        ok: false,
        errorCode: 'session_board_revision_conflict',
        error: 'session_board_revision_conflict',
        details: { currentLayoutRevision: currentRevision },
      },
    } as const;

    const valid = ApprovalRequestV2Schema.safeParse(base);
    expect(valid.success).toBe(true);
    if (!valid.success) throw new Error('expected valid Board approval fixture');
    expect(readApprovalExecutionFailure(valid.data)).toMatchObject({
      details: { currentLayoutRevision: currentRevision },
    });
    const unsafe = ApprovalRequestV2Schema.parse({
      ...base,
      execution: {
        ...base.execution,
        details: { currentLayoutRevision: currentRevision, bearer: 'must-not-persist' },
      },
    });
    expect(parseSessionBoardActionPortResultV1('session.board.layout.update', base.actionArgs, {
      ok: false, errorCode: base.execution.errorCode, error: base.execution.error,
      details: unsafe.execution?.ok === false ? unsafe.execution.details : undefined,
    }).success).toBe(false);
    expect(readApprovalExecutionFailure(unsafe)).toEqual({
      ok: false,
      errorCode: 'session_board_revision_conflict',
      error: 'session_board_revision_conflict',
      details: { currentLayoutRevision: currentRevision },
    });
    const otherAction = ApprovalRequestV2Schema.parse({
      ...base,
      actionId: 'session.title.set',
      actionArgs: { sessionId: 'session-1', title: 'Title' },
      executionOriginV1: {
        ...base.executionOriginV1,
        actionId: 'session.title.set',
      },
    });
    expect(readApprovalExecutionFailure(otherAction)).toEqual({
      ok: false,
      errorCode: 'session_board_revision_conflict',
      error: 'session_board_revision_conflict',
    });
  });

  it('parses a minimal open approval request', () => {
    const parsed = ApprovalRequestV1Schema.parse({
      v: 1,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'system' },
      actionId: 'review.start',
      actionArgs: { sessionId: 's1', engineIds: ['x'], instructions: 'y' },
      summary: 'Run review',
    });

    expect(parsed.status).toBe('open');
    expect(parsed.actionId).toBe('review.start');
  });

  it('keeps legacy failed approvals readable without trusting opaque detail bags', () => {
    const legacy = ApprovalRequestV1Schema.parse({
      v: 1,
      status: 'failed',
      createdAtMs: 1,
      updatedAtMs: 3,
      createdBy: { surface: 'system' },
      actionId: 'session.title.set',
      actionArgs: { sessionId: 's1', title: 'Title' },
      summary: 'Set title',
      decision: { kind: 'approve', decidedAtMs: 2 },
      execution: {
        executedAtMs: 3,
        ok: false,
        errorCode: 'action_failed',
        error: 'action_failed',
        details: { bearer: 'legacy-untrusted-value' },
      },
    });

    expect(readApprovalExecutionFailure(legacy)).toEqual({
      ok: false,
      errorCode: 'action_failed',
      error: 'action_failed',
    });
  });

  it('keeps released V1 readable but rejects the V2 epoch', () => {
    const legacy = {
      v: 1,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'system' },
      actionId: 'session.title.set',
      actionArgs: { sessionId: 's1', title: 'Legacy' },
      summary: 'Set title',
    } as const;
    const current = {
      ...legacy,
      v: 2,
      executionOriginV1: {
        v: 1,
        authority: 'account_automation',
        surface: 'api',
        caller: { kind: 'host' },
        serverId: 'home-1',
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        sessionId: 's1',
        target: { kind: 'session', sessionId: 's1' },
        actionId: 'session.title.set',
        requestId: 'request-1',
      },
    } as const;

    expect(ApprovalRequestV1Schema.safeParse(legacy).success).toBe(true);
    expect(ApprovalRequestV1Schema.safeParse(current).success).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse(current).success).toBe(true);
    expect(ApprovalRequestSchema.safeParse(legacy).success).toBe(true);
    expect(ApprovalRequestSchema.safeParse(current).success).toBe(true);
  });

  it('keeps executing exclusive to current V2 approval requests', () => {
    const current = {
      v: 2,
      status: 'executing',
      createdAtMs: 1,
      updatedAtMs: 2,
      createdBy: { surface: 'system' },
      actionId: 'session.title.set',
      actionArgs: { sessionId: 's1', title: 'Approved' },
      summary: 'Set title',
      decision: { kind: 'approve', decidedAtMs: 1 },
      executionOriginV1: {
        v: 1,
        authority: 'account_automation',
        surface: 'cli',
        caller: { kind: 'host' },
        serverId: 'home-1',
        actionId: 'session.title.set',
        requestId: 'request-1',
      },
    } as const;

    expect(ApprovalRequestV2Schema.safeParse(current).success).toBe(true);
    expect(ApprovalRequestV1Schema.safeParse({ ...current, v: 1 }).success).toBe(false);
  });

  it('requires a strict secret-free execution origin on V2', () => {
    const base = {
      v: 2,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'agent', sessionId: 's1' },
      actionId: 'session.title.set',
      actionArgs: { sessionId: 's1', title: 'Approved' },
      summary: 'Set title',
      executionOriginV1: {
        v: 1,
        authority: 'account_automation',
        surface: 'agent',
        caller: {
          kind: 'plugin',
          pluginId: 'plugin.example',
          contributionLocalId: 'tool',
          sourceCustody: {
            kind: 'managed',
            immutableGenerationId: 'generation-1',
            installSource: 'npm',
          },
        },
        serverId: 'home-1',
        accountId: 'account-1',
        sessionId: 's1',
        machineId: 'machine-1',
        runId: 'run-1',
        actionId: 'session.title.set',
        requestId: 'request-1',
      },
    } as const;

    expect(ApprovalRequestV2Schema.safeParse(base).success).toBe(true);
    const permissionOrigin = {
      ...base.executionOriginV1,
      callerPermissionMode: 'safe-yolo',
      sessionAgentSpawnPolicyV1: { permissionCeiling: 'read-only' },
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' },
      sessionInputSource: { sourceSessionId: 's1', sourceTurnId: 'turn-1', via: 'mcp' },
    };
    expect(ApprovalRequestV2Schema.safeParse({ ...base, executionOriginV1: permissionOrigin }).success).toBe(true);
    expect(ApprovalRequestV2Schema.safeParse({ ...base, executionOriginV1: {
      ...permissionOrigin, callerPermissionMode: 'invented-mode',
    } }).success).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse({ ...base, executionOriginV1: {
      ...permissionOrigin, sessionAgentSpawnPolicyV1: { permissionCeiling: 'invented-mode' },
    } }).success).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse({ ...base, executionOriginV1: {
      ...permissionOrigin, sessionAgentSpawnPolicyV1: { bearer: 'secret' },
    } }).success).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse({ ...base, executionOriginV1: {
      ...permissionOrigin, causalPermissionAuthority: { ...permissionOrigin.causalPermissionAuthority, bearer: 'secret' },
    } }).success).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse({ ...base, executionOriginV1: undefined }).success).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse({
      ...base,
      executionOriginV1: { ...base.executionOriginV1, bearer: 'secret-token' },
    }).success).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse({
      ...base,
      executionOriginV1: {
        ...base.executionOriginV1,
        caller: { ...base.executionOriginV1.caller, occurrenceId: 'process-local' },
      },
    }).success).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse({ ...base, unknown: true }).success).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse({
      ...base,
      executionOriginV1: {
        ...base.executionOriginV1,
        target: { kind: 'session', sessionId: 'other-session' },
      },
    }).success).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse({
      ...base,
      executionOriginV1: {
        ...base.executionOriginV1,
        accountId: undefined,
        principalId: 'principal-1',
        credentialId: 'credential-1',
      },
    }).success).toBe(false);
  });

  it('binds an API approval to the complete encrypted Machine target', () => {
    const bindingTarget = {
      kind: 'machine' as const,
      machineId: 'machine-1',
      project: {
        machineId: 'machine-1',
        directory: '/workspace/original',
        workspaceRefId: 'workspace-1',
      },
    };
    const request = {
      v: 2,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'mcp' },
      actionId: 'session.list',
      actionArgs: {},
      summary: 'List sessions',
      executionOriginV1: {
        v: 1,
        authority: 'account_automation',
        surface: 'api',
        caller: { kind: 'host' },
        serverId: 'home-1',
        serverIdentityId: 'home-identity-1',
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        machineId: 'machine-1',
        target: {
          ...bindingTarget,
          project: { ...bindingTarget.project, directory: '/workspace/substituted' },
        },
        actionId: 'session.list',
        requestId: 'request-1',
        externalActionInputSignature: 'a'.repeat(86),
        externalActionExecutionAuthorization: {
          v: 1,
          token: 'home-signed-authorization',
          binding: {
            serverIdentityId: 'home-identity-1',
            accountId: 'account-1',
            principalId: 'principal-1',
            credentialId: 'credential-1',
            machineId: 'machine-1',
            actionId: 'session.list',
            requestId: 'request-1',
            requestEnvelopeDigest: 'a'.repeat(43),
            target: bindingTarget,
            grant: API_TOKEN_FULL_GRANT_V1,
          },
        },
      },
    };

    expect(ApprovalRequestV2Schema.safeParse(request).success).toBe(false);
  });

  it('retains the exact resolved Session for an approval relayed through its selected Machine', () => {
    const request = {
      v: 2,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'system' },
      actionId: 'session.title.set',
      actionArgs: { sessionId: 'session-1', title: 'Approved title' },
      summary: 'Set title',
      executionOriginV1: {
        v: 1,
        authority: 'account_automation',
        surface: 'api',
        caller: { kind: 'host' },
        serverId: 'home-profile-1',
        serverIdentityId: 'home-identity-1',
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        sessionId: 'session-1',
        machineId: 'machine-1',
        target: { kind: 'session', sessionId: 'session-1' },
        actionId: 'session.title.set',
        requestId: 'request-1',
        externalActionInputSignature: 'a'.repeat(86),
        externalActionExecutionAuthorization: {
          v: 1,
          token: 'home-signed-authorization',
          binding: {
            serverIdentityId: 'home-identity-1',
            accountId: 'account-1',
            principalId: 'principal-1',
            credentialId: 'credential-1',
            machineId: 'machine-1',
            custodianAccountId: 'account-1',
            installationId: 'installation-1',
            actionId: 'session.title.set',
            requestId: 'request-1',
            requestEnvelopeDigest: 'a'.repeat(43),
            target: { kind: 'machine', machineId: 'machine-1' },
            grant: API_TOKEN_FULL_GRANT_V1,
          },
        },
      },
    } as const;

    expect(ApprovalRequestV2Schema.safeParse(request).success).toBe(true);
    expect(ApprovalRequestV2Schema.safeParse({
      ...request,
      executionOriginV1: { ...request.executionOriginV1, target: { kind: 'session', sessionId: 'other-session' } },
    }).success).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse({
      ...request,
      executionOriginV1: { ...request.executionOriginV1, machineId: 'other-machine' },
    }).success).toBe(false);
  });

  it('parses optional approval routing metadata while preserving old artifacts', () => {
    const oldArtifact = ApprovalRequestV1Schema.parse({
      v: 1,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'system' },
      actionId: 'review.start',
      actionArgs: { sessionId: 's1', engineIds: ['x'], instructions: 'y' },
      summary: 'Run review',
    });
    const newArtifact = ApprovalRequestV1Schema.parse({
      v: 1,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'system' },
      actionId: 'session.list',
      actionArgs: {},
      summary: 'List sessions',
      approval: { flow: 'blocking', result: 'required' },
    });

    expect(oldArtifact.approval).toBeUndefined();
    expect(newArtifact.approval).toEqual({ flow: 'blocking', result: 'required' });
  });

  it('parses transcript tool-call origin metadata', () => {
    const parsed = ApprovalRequestV1Schema.parse({
      v: 1,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'agent', sessionId: 's1' },
      actionId: 'session.list',
      actionArgs: {},
      summary: 'List sessions',
      origin: {
        kind: 'transcript_tool_call',
        sessionId: 's1',
        messageId: 'msg-1',
        toolCallId: 'tool-1',
        toolName: 'session_list',
        toolInput: { limit: 20 },
      },
    });

    expect(parsed.origin).toEqual({
      kind: 'transcript_tool_call',
      sessionId: 's1',
      messageId: 'msg-1',
      toolCallId: 'tool-1',
      toolName: 'session_list',
      toolInput: { limit: 20 },
    });
  });

  it('rejects malformed transcript tool-call origin metadata', () => {
    expect(() => ApprovalRequestV1Schema.parse({
      v: 1,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'agent', sessionId: 's1' },
      actionId: 'session.list',
      actionArgs: {},
      summary: 'List sessions',
      origin: {
        kind: 'transcript_tool_call',
        messageId: 'msg-1',
      },
    })).toThrow(/origin/i);
  });

  it('rejects malformed approval routing metadata', () => {
    expect(() => ApprovalRequestV1Schema.parse({
      v: 1,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'system' },
      actionId: 'session.list',
      actionArgs: {},
      summary: 'List sessions',
      approval: { result: 'optional' },
    })).toThrow(/flow/i);
  });

  it('accepts createdBy.surface=cli for requests created from the CLI surface', () => {
    const parsed = ApprovalRequestV1Schema.parse({
      v: 1,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'cli', sessionId: 's1' },
      actionId: 'review.start',
      actionArgs: { sessionId: 's1', engineIds: ['x'], instructions: 'y' },
      summary: 'Run review',
    });

    expect(parsed.createdBy.surface).toBe('cli');
    expect(parsed.createdBy.sessionId).toBe('s1');
  });

  it('allows cli as a createdBy surface', () => {
    const parsed = ApprovalRequestV1Schema.parse({
      v: 1,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'cli' },
      actionId: 'review.start',
      actionArgs: { sessionId: 's1', engineIds: ['x'], instructions: 'y' },
      summary: 'Run review',
    });

    expect(parsed.createdBy.surface).toBe('cli');
  });

  it('rejects open requests that already include a decision or execution payload', () => {
    expect(() => ApprovalRequestV1Schema.parse({
      v: 1,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'system' },
      actionId: 'review.start',
      actionArgs: { sessionId: 's1', engineIds: ['x'], instructions: 'y' },
      summary: 'Run review',
      decision: { kind: 'approve', decidedAtMs: 2 },
    })).toThrow(/decision/i);

    expect(() => ApprovalRequestV1Schema.parse({
      v: 1,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'system' },
      actionId: 'review.start',
      actionArgs: { sessionId: 's1', engineIds: ['x'], instructions: 'y' },
      summary: 'Run review',
      execution: { executedAtMs: 3, ok: true },
    })).toThrow(/execution/i);
  });

  it('requires a decision for approved, rejected, executed, and failed requests', () => {
    for (const status of ['approved', 'rejected', 'executed', 'failed'] as const) {
      expect(() => ApprovalRequestV1Schema.parse({
        v: 1,
        status,
        createdAtMs: 1,
        updatedAtMs: 1,
        createdBy: { surface: 'system' },
        actionId: 'review.start',
        actionArgs: { sessionId: 's1', engineIds: ['x'], instructions: 'y' },
        summary: 'Run review',
      })).toThrow(/decision/i);
    }
  });

  it('requires execution metadata for executed and failed requests', () => {
    for (const status of ['executed', 'failed'] as const) {
      expect(() => ApprovalRequestV1Schema.parse({
        v: 1,
        status,
        createdAtMs: 1,
        updatedAtMs: 1,
        createdBy: { surface: 'system' },
        actionId: 'review.start',
        actionArgs: { sessionId: 's1', engineIds: ['x'], instructions: 'y' },
        summary: 'Run review',
        decision: { kind: 'approve', decidedAtMs: 2 },
      })).toThrow(/execution/i);
    }
  });

  it('rejects execution metadata before an approval reaches executed or failed', () => {
    for (const status of ['approved', 'rejected', 'canceled'] as const) {
      expect(() => ApprovalRequestV1Schema.parse({
        v: 1,
        status,
        createdAtMs: 1,
        updatedAtMs: 2,
        createdBy: { surface: 'system' },
        actionId: 'review.start',
        actionArgs: { sessionId: 's1', engineIds: ['x'], instructions: 'y' },
        summary: 'Run review',
        ...(status === 'canceled' ? {} : { decision: { kind: status === 'approved' ? 'approve' : 'reject', decidedAtMs: 2 } }),
        execution: { executedAtMs: 3, ok: true, result: { ok: true } },
      })).toThrow(/execution/i);
    }
  });

  it('rejects decision kinds that do not match the approval status', () => {
    const cases = [
      { status: 'approved', decisionKind: 'reject' },
      { status: 'rejected', decisionKind: 'approve' },
      { status: 'executed', decisionKind: 'reject', execution: { executedAtMs: 3, ok: true } },
      { status: 'failed', decisionKind: 'reject', execution: { executedAtMs: 3, ok: false } },
      { status: 'canceled', decisionKind: 'reject' },
    ] as const;

    for (const entry of cases) {
      expect(() => ApprovalRequestV1Schema.parse({
        v: 1,
        status: entry.status,
        createdAtMs: 1,
        updatedAtMs: 2,
        createdBy: { surface: 'system' },
        actionId: 'review.start',
        actionArgs: { sessionId: 's1', engineIds: ['x'], instructions: 'y' },
        summary: 'Run review',
        decision: { kind: entry.decisionKind, decidedAtMs: 2 },
        ...(entry.execution ? { execution: entry.execution } : {}),
      })).toThrow(/decision/i);
    }
  });

  it('rejects execution outcomes that do not match the approval status', () => {
    const cases = [
      { status: 'executed', executionOk: false },
      { status: 'failed', executionOk: true },
    ] as const;

    for (const entry of cases) {
      expect(() => ApprovalRequestV1Schema.parse({
        v: 1,
        status: entry.status,
        createdAtMs: 1,
        updatedAtMs: 2,
        createdBy: { surface: 'system' },
        actionId: 'review.start',
        actionArgs: { sessionId: 's1', engineIds: ['x'], instructions: 'y' },
        summary: 'Run review',
        decision: { kind: 'approve', decidedAtMs: 2 },
        execution: { executedAtMs: 3, ok: entry.executionOk },
      })).toThrow(/execution/i);
    }
  });

  it('reads the released session picker V1 artifact without restoring its executable Action id', () => {
    const releasedV1Artifact = {
      v: 1,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'system' },
      actionId: 'session.spawn_picker',
      actionArgs: { tag: 'release-history', initialMessage: 'Choose a session target' },
      summary: 'Choose a session target',
    } as const;

    expect(ApprovalRequestV1Schema.safeParse(releasedV1Artifact).success).toBe(true);
    expect(ApprovalRequestSchema.safeParse(releasedV1Artifact).success).toBe(true);
    expect(ActionIdSchema.safeParse('session.spawn_picker').success).toBe(false);
    expect(ApprovalRequestV1Schema.safeParse({
      ...releasedV1Artifact,
      actionId: 'session.arbitrary_retired_action',
    }).success).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse({
      ...releasedV1Artifact,
      v: 2,
      executionOriginV1: {
        v: 1,
        authority: 'account_automation',
        surface: 'api',
        caller: { kind: 'host' },
        serverId: 'home-1',
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        actionId: 'session.spawn_picker',
        requestId: 'request-1',
      },
    }).success).toBe(false);
  });
});

describe('requiresExactDaemonApprovalReplay', () => {
  function hostCliRequest(actionId: Parameters<typeof getActionSpec>[0], actionArgs: unknown) {
    return ApprovalRequestV2Schema.parse({
      v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId,
      actionArgs: getActionSpec(actionId).inputSchema.parse(actionArgs), summary: 'Reviewed CLI Action',
      executionOriginV1: {
        v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
        serverId: 'creator-profile', serverIdentityId: 'stable-home', accountId: 'account-1',
        actionId, requestId: 'request-1',
      },
    });
  }

  it('replays an unsigned host CLI Account effect at the deciding Home without inventing a Machine', () => {
    const request = ApprovalRequestV2Schema.parse({
      v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli',
      actionId: 'launch_profiles.delete', actionArgs: { id: 'own-profile', expectedRevision: 0 },
      summary: 'Delete launch profile',
      executionOriginV1: {
        v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
        serverId: 'creator-profile', serverIdentityId: 'stable-home', accountId: 'account-1',
        actionId: 'launch_profiles.delete', requestId: 'request-1',
      },
    });
    expect(requiresExactDaemonApprovalReplay(request)).toBe(false);
    expect(requiresExactDaemonApprovalReplay({ ...request, executionOriginV1: {
      ...request.executionOriginV1,
      caller: { kind: 'session', sessionId: 'session-1', starterDepth: 0, turnDepth: 0 },
    } })).toBe(true);
  });

  it('replays unsigned host CLI Account effects outside the Profile family', () => {
    expect(requiresExactDaemonApprovalReplay(hostCliRequest('remote_hosts.delete', {
      hostId: 'reviewed-host', expectedRevision: 3,
    }))).toBe(false);
    expect(requiresExactDaemonApprovalReplay(hostCliRequest('account.apiTokens.revokeAll', {}))).toBe(false);
    expect(requiresExactDaemonApprovalReplay(hostCliRequest('session.reports_to.set', {
      sessionId: 'worker', leadSessionId: 'lead', expectedLeadSessionId: null,
    }))).toBe(false);
  });

  it('uses reviewed input placement rather than an Account default for host CLI custody', () => {
    expect(requiresExactDaemonApprovalReplay(hostCliRequest('providers.connections.describe', {}))).toBe(false);
    expect(requiresExactDaemonApprovalReplay(hostCliRequest('providers.connections.describe', {
      machineId: 'machine-1',
    }))).toBe(true);
  });

  it('keeps signed external CLI requests for Account effects on their admitting daemon', () => {
    const request = hostCliRequest('launch_profiles.delete', { id: 'own-profile', expectedRevision: 0 });
    const target = { kind: 'machine' as const, machineId: 'machine-1' };
    // External CLI ingress has API authority; the reviewed descriptive surface stays CLI.
    const signed = ApprovalRequestV2Schema.parse({ ...request, executionOriginV1: {
      ...request.executionOriginV1, surface: 'api', machineId: target.machineId, target,
      principalId: 'principal-1', credentialId: 'credential-1', externalActionInputSignature: 'a'.repeat(86),
      externalActionExecutionAuthorization: { v: 1, token: 'home-signed-authorization', binding: {
        serverIdentityId: 'stable-home', accountId: 'account-1', principalId: 'principal-1',
        credentialId: 'credential-1', machineId: target.machineId, custodianAccountId: 'account-1',
        installationId: 'installation-1', actionId: request.actionId, requestId: 'request-1',
        requestEnvelopeDigest: 'a'.repeat(43), target, grant: API_TOKEN_FULL_GRANT_V1,
      } },
    } });
    expect(requiresExactDaemonApprovalReplay(signed)).toBe(true);
  });

  it.each(['teams.invitations.create', 'teams.invitations.reissue'] as const)(
    'replays signed Session %s in the approving app', actionId => {
      const caller = { kind: 'session' as const, sessionId: 'source', starterDepth: 0, turnDepth: 0 };
      const target = { kind: 'machine' as const, machineId: 'source-machine' };
      const actionArgs = getActionSpec(actionId).inputSchema.parse(actionId.endsWith('create')
        ? { v: 1, teamId: 'team', role: 'member', historyAccess: 'from_membership', recipientEmail: null, requestKey: 'create-request' }
        : { v: 1, teamId: 'team', invitationId: 'invitation', recipientEmail: null, requestKey: 'reissue-request' });
      const request = ApprovalRequestV2Schema.parse({
        v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1, actionId, actionArgs, summary: 'Invitation proposal',
        createdBy: { surface: 'agent', sessionId: 'source' }, requestedSurface: 'agent',
        executionOriginV1: { v: 1, surface: 'agent', authority: 'account_automation', caller,
          serverId: 'profile', serverIdentityId: 'stable-home', accountId: 'account', machineId: target.machineId,
          sessionId: 'source', target, actionId, requestId: 'proposal-request', callerPermissionMode: null,
          sessionInputSource: { sourceSessionId: 'source', sourceTurnId: 'turn', via: 'action' },
          externalActionInputSignature: 'a'.repeat(86), externalActionExecutionAuthorization: {
            v: 1, token: 'signed-proposal-fixture', binding: { serverIdentityId: 'stable-home', accountId: 'account',
              authentication: { kind: 'account', tokenEpoch: 0 }, machineId: target.machineId,
              custodianAccountId: 'account', installationId: 'installation', actionId, requestId: 'proposal-request',
              requestEnvelopeDigest: 'a'.repeat(43), target,
              sessionActionOrigin: { v: 1, caller, sourceTurnId: 'turn', callerPermissionMode: null, requestId: 'proposal-request' },
              sessionActionSource: { machineId: target.machineId, installationId: 'installation' },
            },
          },
        },
      });
      // Owner ruling 2026-10-12: the approving app runs the Account-only effect.
      expect(requiresExactDaemonApprovalReplay(request)).toBe(false);
      // The same signed origin cannot move a Machine effect into the app.
      expect(requiresExactDaemonApprovalReplay({ ...request, actionId: 'paths.list_recent',
        actionArgs: { machineId: target.machineId, limit: 10 },
        executionOriginV1: { ...request.executionOriginV1, actionId: 'paths.list_recent' } })).toBe(true);
    },
  );

  it('keeps Machine, Session and client placement and live-only Account inputs on the exact CLI daemon', () => {
    for (const request of [
      hostCliRequest('paths.list_recent', { machineId: 'machine-1', limit: 10 }),
      hostCliRequest('session.stop', { sessionId: 'session-1' }),
      hostCliRequest('remote_hosts.edit', { hostId: 'reviewed-host', expectedRevision: 3 }),
      hostCliRequest('remote_hosts.save', {
        host: { id: 'reviewed-host', name: 'Reviewed host', createdAt: 1, updatedAt: 1,
          lastUsedAt: null, ssh: { target: 'user@example.test', authMode: 'agent' } },
        expectedRevision: 3,
      }),
    ]) expect(requiresExactDaemonApprovalReplay(request), request.actionId).toBe(true);
  });

  it('routes signed present-user UI approval custody to its admitting daemon', () => {
    const target = { kind: 'machine' as const, machineId: 'controller' };
    const actionId = 'machines.managed.acquire';
    const approval = ApprovalRequestV2Schema.parse({
      v: 2, status: 'approved', createdAtMs: 1, updatedAtMs: 2,
      createdBy: { surface: 'system' }, requestedSurface: 'ui', actionId,
      actionArgs: {}, summary: 'Create machine', decision: { kind: 'approve', decidedAtMs: 2 },
      executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' },
        serverId: 'profile', serverIdentityId: 'srv_home', accountId: 'requester', machineId: target.machineId,
        actionId, requestId: 'reviewed-request', target, externalActionInputSignature: 'a'.repeat(86),
        externalActionExecutionAuthorization: { v: 1, token: 'home-signed', binding: {
          accountId: 'requester', authentication: { kind: 'account', tokenEpoch: 7 },
          serverIdentityId: 'srv_home', machineId: target.machineId, custodianAccountId: 'requester',
          installationId: 'installation', actionId, requestId: 'reviewed-request',
          requestEnvelopeDigest: 'a'.repeat(43), target,
        } },
      },
    });
    expect(requiresExactDaemonApprovalReplay(approval)).toBe(true);
    const { externalActionExecutionAuthorization: _authorization, externalActionInputSignature: _signature,
      ...localOrigin } = approval.executionOriginV1;
    expect(requiresExactDaemonApprovalReplay({ ...approval, executionOriginV1: localOrigin })).toBe(false);
  });

  it('keeps host Agent/MCP Account security requests on the deciding human Home adapter', () => {
    for (const surface of ['agent', 'mcp'] as const) {
      const approval = ApprovalRequestV2Schema.parse({
        v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface, sessionId: 'session-1' }, requestedSurface: surface,
        actionId: 'account.apiTokens.revokeAll', actionArgs: {}, summary: 'Revoke tokens',
        executionOriginV1: { v: 1, authority: 'account_automation', surface,
          caller: { kind: 'host' }, serverId: 'home', actionId: 'account.apiTokens.revokeAll',
          requestId: 'request', sessionId: 'session-1', target: { kind: 'session', sessionId: 'session-1' } },
      });
      expect(requiresExactDaemonApprovalReplay(approval)).toBe(false);
    }
  });
  function approvalWithCaller(caller: unknown): unknown {
    return {
      v: 2,
      status: 'approved',
      createdAtMs: 1,
      updatedAtMs: 2,
      createdBy: { surface: 'system' },
      requestedSurface: 'ui',
      actionId: 'session.title.set',
      actionArgs: { sessionId: 'session-1', title: 'Reviewed title' },
      summary: 'Set title',
      decision: { kind: 'approve', decidedAtMs: 2 },
      executionOriginV1: {
        v: 1,
        authority: 'present_user',
        surface: 'ui',
        caller,
        serverId: 'home-1',
        accountId: 'account-1',
        sessionId: 'session-1',
        target: { kind: 'session', sessionId: 'session-1' },
        actionId: 'session.title.set',
        requestId: 'request-1',
      },
    };
  }

  it('routes every caller whose currentness only the admitting daemon owns', () => {
    const host = ApprovalRequestV2Schema.parse(approvalWithCaller({ kind: 'host' }));
    expect(requiresExactDaemonApprovalReplay(host)).toBe(false);

    const sessionCaller = { kind: 'session', sessionId: 'session-caller', starterDepth: 2, turnDepth: 3 };
    const session = ApprovalRequestV2Schema.parse(approvalWithCaller(sessionCaller));
    expect(session.executionOriginV1.caller).toEqual(sessionCaller);
    expect(requiresExactDaemonApprovalReplay(session)).toBe(true);
    expect(ApprovalRequestV2Schema.safeParse(approvalWithCaller({ ...sessionCaller, capability: 'secret' })).success).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse(approvalWithCaller({ ...sessionCaller, sessionId: ' ' })).success).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse(approvalWithCaller({ kind: 'session', sessionId: 'session-caller' })).success).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse(approvalWithCaller({ ...sessionCaller, starterDepth: undefined })).success).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse(approvalWithCaller({ ...sessionCaller, turnDepth: -1 })).success).toBe(false);

    const workflowRun = ApprovalRequestV2Schema.parse(approvalWithCaller({
      kind: 'workflowRun',
      runId: 'workflow-run-1',
      authorization: {
        admittedPermissionCeiling: 'default',
        principal: {
          kind: 'api',
          accountId: 'account-1',
          principalId: 'principal-1',
          credentialId: 'credential-1',
        },
      },
    }));
    expect(requiresExactDaemonApprovalReplay(workflowRun)).toBe(true);

    const automationCaller = {
      kind: 'automationRun',
      runId: 'automation-run-1',
      automationId: 'automation-1',
      cause: { kind: 'manual', invokedAt: 1_700_000_000_000 },
    } as const;
    const automationRun = ApprovalRequestV2Schema.parse({
      ...approvalWithCaller(automationCaller) as Record<string, unknown>,
      executionOriginV1: {
        ...(approvalWithCaller(automationCaller) as { executionOriginV1: Record<string, unknown> }).executionOriginV1,
        runId: 'automation-run-1',
      },
    });
    expect(requiresExactDaemonApprovalReplay(automationRun)).toBe(true);
  });

  it('replays host CLI Account requests while retaining exact-daemon custody for other autonomous surfaces', () => {
    for (const surface of ['agent', 'mcp', 'cli', 'rpc'] as const) {
      const request = ApprovalRequestV2Schema.parse({
        ...approvalWithCaller({ kind: 'host' }) as Record<string, unknown>,
        requestedSurface: surface,
        executionOriginV1: {
          ...(approvalWithCaller({ kind: 'host' }) as { executionOriginV1: Record<string, unknown> }).executionOriginV1,
          authority: 'account_automation',
          surface,
        },
      });
      expect(requiresExactDaemonApprovalReplay(request), surface).toBe(surface !== 'cli');
    }

    const apiRequest = ApprovalRequestV2Schema.parse({
      ...approvalWithCaller({ kind: 'host' }) as Record<string, unknown>,
      requestedSurface: 'api',
      executionOriginV1: {
        ...(approvalWithCaller({ kind: 'host' }) as { executionOriginV1: Record<string, unknown> }).executionOriginV1,
        authority: 'account_automation',
        surface: 'api',
        principalId: 'principal-1',
        credentialId: 'credential-1',
      },
    });
    expect(requiresExactDaemonApprovalReplay(apiRequest)).toBe(true);
  });
});
