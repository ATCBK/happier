import { describe, expect, it } from 'vitest';
import { TargetActionApprovalRequestV1Schema } from './targetActionApprovalRequestV1';
import { computeActionInputApprovalDigestV1 } from '../actions/decisionAuthority';

describe('TargetActionApprovalRequestV1Schema', () => {
  it('binds shared-Bot confirmation and its deciding person without changing executor custody', () => {
    const requesterConfirmation = {
      requestRef: 'request-bob', requesterAccountId: 'bob',
      personaSessionRef: { serverId: 'server-1', sessionId: 'bot-session' },
      executionAccountId: 'alice', inputDigest: computeActionInputApprovalDigestV1('action.invoke', {
        action: { pluginId: 'acme.alpha', localId: 'run' }, input: { value: 'x' },
      }),
    };
    const request = {
      v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'agent' }, requestedSurface: 'agent', qualifiedActionId: 'acme.alpha/actions/run',
      input: { value: 'x' }, sourceCustody: { kind: 'development', registeredRootId: 'root-7' },
      policyFingerprint: 'b'.repeat(64), subjectFingerprint: 'c'.repeat(64), summary: 'Run',
      requesterConfirmation,
      executionOriginV1: {
        v: 1, authority: 'account_automation', surface: 'agent', caller: { kind: 'host' },
        serverId: 'server-1', accountId: 'alice', sessionId: 'bot-session', actionId: 'action.invoke', requestId: 'request-1',
        actionRequestAttributionV1: {
          requestRef: 'request-bob', requester: { serverId: 'server-1', accountId: 'bob' },
          persona: { serverId: 'server-1', sessionId: 'bot-session' }, origin: null,
        },
      },
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
