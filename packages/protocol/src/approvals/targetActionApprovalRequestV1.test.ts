import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { StoredTargetActionApprovalRequestV1Schema, TargetActionApprovalRequestV1Schema } from './targetActionApprovalRequestV1';
import { ActionOperationCredentialUseV1Schema } from '../actions/actionExecutionResult';
import { buildApprovalRequesterConfirmationV1 } from './approvalRequestV1';
import { buildApprovalExecutionOriginV1 } from '../actions/actionExecutor';
import type { ActionExecutorContext } from '../actions/executor/types';
import { ExternalActionExecutionAuthorizationV1Schema } from '../actions/externalActionApi';
import {
  computeExternalActionRequestEnvelopeDigestV1,
  signExternalActionApprovalInputV1,
  verifyExternalActionApprovalInputV1,
} from '../actions/externalActionExecutionAuthorization';
import { SessionActionRpcOriginV1Schema } from '../rpc/socket';
import { computeActionInputApprovalDigestV1 } from '../actions/decisionAuthority';

describe('TargetActionApprovalRequestV1Schema', () => {
  it('binds shared-Bot confirmation and its deciding person without changing executor custody', () => {
    const input = { action: { pluginId: 'acme.alpha', localId: 'run' }, input: { value: 'x' } };
    const target = { kind: 'session' as const, sessionId: 'bot-session' };
    const sessionActionOrigin = SessionActionRpcOriginV1Schema.parse({ v: 1,
      caller: { kind: 'session', sessionId: 'bot-session', starterDepth: 0, turnDepth: 0 },
      sourceTurnId: 'bot-turn', callerPermissionMode: 'default', workspaceWrites: 'allow', requestId: 'request-1' });
    // The Home token is an opaque transport boundary; the origin and its input signature use real producers.
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-issued-authorization', binding: {
      accountId: 'alice', custodianAccountId: 'alice', authentication: { kind: 'account', tokenEpoch: 1 },
      serverIdentityId: 'srv_home', machineId: 'machine-1', installationId: 'installation-1',
      actionId: 'action.invoke', requestId: 'request-1', target,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId: 'request-1', target, input }),
      sessionActionOrigin, sessionActionSource: { machineId: 'machine-1', installationId: 'installation-1' },
    } });
    const keys = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19));
    const context: ActionExecutorContext = {
      surface: 'agent', authority: 'account_automation', runtimeAccountId: 'alice', serverId: 'server-1',
      serverIdentityId: 'srv_home', defaultSessionId: 'bot-session', actionRequestId: 'request-1',
      actionCaller: sessionActionOrigin.caller, callerPermissionMode: sessionActionOrigin.callerPermissionMode,
      workspaceWrites: sessionActionOrigin.workspaceWrites,
      sessionInputSource: { sourceSessionId: 'bot-session', sourceTurnId: 'bot-turn', via: 'action' },
      actionRequestAttributionV1: { requestRef: 'request-bob', requester: { serverId: 'server-1', accountId: 'bob' },
        persona: { serverId: 'server-1', sessionId: 'bot-session' }, origin: null },
      externalActionTarget: target, externalActionExecutionAuthorization: authorization,
      signExternalActionApprovalInput: request => signExternalActionApprovalInputV1({ actionId: request.actionId,
        input: request.input, target: request.target, authorizationToken: request.authorization.token,
        requesterConfirmation: request.requesterConfirmation, privateKey: keys.secretKey }),
    };
    const requesterConfirmation = buildApprovalRequesterConfirmationV1({ context, actionId: 'action.invoke', input });
    if (!requesterConfirmation) throw new Error('Expected an admitted shared requester');
    expect(requesterConfirmation).toEqual({ requestRef: 'request-bob', requesterAccountId: 'bob',
      personaSessionRef: { serverId: 'server-1', sessionId: 'bot-session' }, executionAccountId: 'alice',
      inputDigest: computeActionInputApprovalDigestV1('action.invoke', input) });
    const executionOriginV1 = buildApprovalExecutionOriginV1({ context, actionId: 'action.invoke', input,
      targetSessionId: 'bot-session', requesterConfirmation });
    if (!executionOriginV1?.externalActionInputSignature) throw new Error('Expected a signed execution origin');
    expect(executionOriginV1).toMatchObject({ authority: 'account_automation', surface: 'agent',
      accountId: 'alice', serverId: 'server-1', sessionId: 'bot-session', actionId: 'action.invoke', requestId: 'request-1' });
    expect(verifyExternalActionApprovalInputV1({ actionId: 'action.invoke', input, target,
      authorizationToken: authorization.token, requesterConfirmation, publicKey: keys.publicKey,
      signature: executionOriginV1.externalActionInputSignature })).toBe(true);
    const request = {
      v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'agent' }, requestedSurface: 'agent', qualifiedActionId: 'acme.alpha/actions/run',
      input: { value: 'x' }, sourceCustody: { kind: 'development', registeredRootId: 'root-7' },
      policyFingerprint: 'b'.repeat(64), subjectFingerprint: 'c'.repeat(64), summary: 'Run',
      requesterConfirmation,
      executionOriginV1,
    };
    expect(TargetActionApprovalRequestV1Schema.parse(request)).toEqual(request);
    expect(TargetActionApprovalRequestV1Schema.safeParse({
      ...request, status: 'approved',
      decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user', decidingAccountId: 'bob' },
    }).success).toBe(true);
    expect(TargetActionApprovalRequestV1Schema.safeParse({
      ...request, status: 'approved', decision: { kind: 'approve', decidedAtMs: 2 },
    }).success).toBe(false);
    expect(TargetActionApprovalRequestV1Schema.safeParse({
      ...request, requesterConfirmation: { ...requesterConfirmation, requesterAccountId: 'carol' },
    }).success).toBe(false);
    for (const removed of ['externalActionExecutionAuthorization', 'externalActionInputSignature'] as const) {
      const unsignedOrigin = { ...executionOriginV1 };
      delete unsignedOrigin[removed];
      expect(TargetActionApprovalRequestV1Schema.safeParse({ ...request, executionOriginV1: unsignedOrigin }).success).toBe(false);
    }
  });
  it('requires an exact qualified action subject and correlation fingerprint', () => {
    const request = { v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli', qualifiedActionId: 'acme.alpha/actions/run',
      input: { value: 'x' }, sourceCustody: { kind: 'development', registeredRootId: 'root-7' }, policyFingerprint: 'b'.repeat(64), subjectFingerprint: 'a'.repeat(64), summary: 'Run' };
    expect(TargetActionApprovalRequestV1Schema.parse(request)).toEqual(request);
    expect(() => TargetActionApprovalRequestV1Schema.parse({ ...request, qualifiedActionId: 'run' })).toThrow();
    expect(() => TargetActionApprovalRequestV1Schema.parse({ ...request, subjectFingerprint: 'short' })).toThrow();
    expect(() => TargetActionApprovalRequestV1Schema.parse({ ...request, generation: 'occurrence-7' })).toThrow();
    expect(() => TargetActionApprovalRequestV1Schema.parse({ ...request, occurrenceId: 'occurrence-7' })).toThrow();
  });

  it('requires API-created approvals to bind the exact daemon replay placement', () => {
    const request = {
      v: 1,
      kind: 'plugin_target_action',
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'system' },
      requestedSurface: 'api',
      qualifiedActionId: 'acme.alpha/actions/run',
      input: { value: 'x' },
      sourceCustody: { kind: 'development', registeredRootId: 'root-7' },
      policyFingerprint: 'b'.repeat(64),
      subjectFingerprint: 'a'.repeat(64),
      summary: 'Run',
    };

    expect(() => TargetActionApprovalRequestV1Schema.parse(request)).toThrow();
    const admitted = TargetActionApprovalRequestV1Schema.parse({
      ...request,
      replayPlacement: {
        serverId: 'server-1',
        machineId: 'machine-1',
        defaultSessionId: 'session-1',
      },
      executionOriginV1: {
        v: 1,
        authority: 'account_automation',
        surface: 'api',
        caller: { kind: 'host' },
        serverId: 'server-1',
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        machineId: 'machine-1',
        sessionId: 'session-1',
        actionId: 'action.invoke',
        requestId: 'request-1',
      },
    });
    expect(admitted).toMatchObject({
      replayPlacement: {
        serverId: 'server-1',
        machineId: 'machine-1',
        defaultSessionId: 'session-1',
      },
      executionOriginV1: expect.objectContaining({ actionId: 'action.invoke' }),
    });
    expect(TargetActionApprovalRequestV1Schema.safeParse({
      ...admitted,
      executionOriginV1: { ...admitted.executionOriginV1!, machineId: 'other-machine' },
    }).success).toBe(false);
  });

  it('retains bounded host-rendered confirmation detail in the durable subject', () => {
    const request = { v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli', qualifiedActionId: 'acme.alpha/actions/run',
      input: { value: 'x' }, sourceCustody: { kind: 'development', registeredRootId: 'root-7' }, policyFingerprint: 'b'.repeat(64), subjectFingerprint: 'a'.repeat(64),
      summary: 'Start a new baseline', detail: 'Events in the history gap are not replayed.' };
    expect(TargetActionApprovalRequestV1Schema.parse(request)).toEqual(request);
    expect(() => TargetActionApprovalRequestV1Schema.parse({
      ...request,
      detail: 'x'.repeat(4_097),
    })).toThrow();
  });

  it('admits only the canonical closed operation credential receipt on current target approvals', () => {
    const use = ActionOperationCredentialUseV1Schema.parse({
      v: 1, kind: 'team_resource', label: 'Release GitHub', owner: { kind: 'team', teamId: 'team-release' },
      service: { pluginId: 'acme.github', localId: 'github' },
      why: { kind: 'purpose_binding', purpose: { consumer: { pluginId: 'acme.alpha', localId: 'run' }, purpose: 'write' }, target: 'group' },
      currentness: { kind: 'current_at_materialization', resourceRevision: 7 },
    });
    const request = { v: 1, kind: 'plugin_target_action', status: 'executed', createdAtMs: 1, updatedAtMs: 3,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli', qualifiedActionId: 'acme.alpha/actions/run',
      input: { value: 'x' }, sourceCustody: { kind: 'development', registeredRootId: 'root-7' },
      policyFingerprint: 'b'.repeat(64), subjectFingerprint: 'a'.repeat(64), summary: 'Run',
      decision: { kind: 'approve', decidedAtMs: 2 },
      execution: { executedAtMs: 3, ok: true, effectAttempted: true, result: { ok: true }, operationCredentialUses: [use] },
    };
    expect(TargetActionApprovalRequestV1Schema.parse(request)).toEqual(request);
    expect(TargetActionApprovalRequestV1Schema.safeParse({ ...request,
      execution: { ...request.execution, token: 'unadmitted-extra' },
    }).success).toBe(false);
    expect(TargetActionApprovalRequestV1Schema.safeParse({ ...request,
      execution: { ...request.execution, operationCredentialUses: [{ ...use, kind: 'connected_account' }] },
    }).success).toBe(false);
    expect(TargetActionApprovalRequestV1Schema.safeParse({ ...request,
      execution: { ...request.execution, effectAttempted: false },
    }).success).toBe(false);

    const future = { ...request, execution: { ...request.execution, futureAnnotation: 'drop',
      operationCredentialUses: [{ ...use, currentness: { ...use.currentness, futureAnnotation: 'drop' } }],
    } };
    expect(StoredTargetActionApprovalRequestV1Schema.parse(future)).toEqual(request);
    expect(StoredTargetActionApprovalRequestV1Schema.safeParse({ ...request,
      execution: { ...request.execution, operationCredentialUses: [{ ...use, kind: 'connected_account' }] },
    }).success).toBe(false);
  });

  it('keeps historical basic execution fields readable without fabricating credential use', () => {
    const request = { v: 1, kind: 'plugin_target_action', status: 'failed', createdAtMs: 1, updatedAtMs: 3,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli', qualifiedActionId: 'acme.alpha/actions/run',
      input: { value: 'x' }, sourceCustody: { kind: 'development', registeredRootId: 'root-7' },
      policyFingerprint: 'b'.repeat(64), subjectFingerprint: 'a'.repeat(64), summary: 'Run',
      decision: { kind: 'approve', decidedAtMs: 2 },
      execution: { executedAtMs: 3, ok: false, errorCode: 'action_failed', error: 'action_failed', result: { ok: false } },
    };
    expect(TargetActionApprovalRequestV1Schema.parse(request)).toEqual(request);
    expect(StoredTargetActionApprovalRequestV1Schema.parse({ ...request,
      execution: { ...request.execution, futureAnnotation: 'drop' },
    })).toEqual(request);
  });

  it('rejects non-JSON and oversized approval subjects before persistence', () => {
    const request = { v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli', qualifiedActionId: 'acme.alpha/actions/run',
      input: { value: 'x' }, sourceCustody: { kind: 'development', registeredRootId: 'root-7' }, policyFingerprint: 'b'.repeat(64), subjectFingerprint: 'a'.repeat(64), summary: 'Run' };
    expect(() => TargetActionApprovalRequestV1Schema.parse({ ...request, input: { value: BigInt(1) } })).toThrow();
    expect(() => TargetActionApprovalRequestV1Schema.parse({ ...request, input: { value: 'x'.repeat(70_000) } })).toThrow();
    expect(() => TargetActionApprovalRequestV1Schema.parse({ ...request, summary: 'x'.repeat(2_000) })).toThrow();
    expect(() => TargetActionApprovalRequestV1Schema.parse({ ...request, policyFingerprint: 'default' })).toThrow();
    expect(() => TargetActionApprovalRequestV1Schema.parse({
      ...request, status: 'canceled', decision: { kind: 'approve', decidedAtMs: 2 },
    })).toThrow();
    expect(() => TargetActionApprovalRequestV1Schema.parse({
      ...request, status: 'approved', decision: { kind: 'approve', decidedAtMs: 2, hidden: undefined },
    })).toThrow();
    // Target Action approval is unreleased WIP and uses a durable effect claim.
    expect(TargetActionApprovalRequestV1Schema.safeParse({
      ...request, status: 'executing', decision: { kind: 'approve', decidedAtMs: 2 },
    }).success).toBe(true);
    expect(TargetActionApprovalRequestV1Schema.safeParse({
      ...request,
      status: 'executing',
      decision: { kind: 'approve', decidedAtMs: 2 },
      execution: { executedAtMs: 2, ok: true },
    }).success).toBe(false);
  });
});
