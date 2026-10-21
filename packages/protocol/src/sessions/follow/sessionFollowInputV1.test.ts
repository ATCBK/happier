import { describe, expect, it } from 'vitest';
import { SessionInputRequestV1Schema, assertSessionInputAdmissionReceiptForRequestV1, settleSessionMessageProvenanceV1 } from '../messages/sessionInputAdmission.js';
import { isAuthoritativeHumanSessionFollowMessageV1 } from './sessionFollowUpdateEnvelopeV1.js';
import { SessionFollowObservePendingRequestV1Schema, SessionFollowAcknowledgeRequestV1Schema, SessionFollowPendingObservationV1Schema } from './sessionFollowTransportV1.js';
import { SessionFollowSourceProjectionRequestV1Schema } from './sessionFollowSourceProjectionV1.js';
import { deriveSessionFollowOriginalOccurrenceKeyV1, resolveExecutionRunFollowOccurrenceV1, SessionFollowInputV1Schema } from './sessionFollowInputV1.js';
import { FOLLOW_EVENT_KINDS_V1 } from './sessionFollowPolicyV1.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { SessionFollowRelationWitnessesV1Schema } from './sessionFollowSourceOccurrenceV1.js';

const witness = { sourceSessionId: 'source', destinationSessionId: 'receiver',
  sourceMessage: { localId: 'report', seq: 3 }, expectedSourcePublisherGeneration: '1', machineId: 'source-machine', installationId: 'install',
  rule: { ruleId: 'project', ruleVersion: 1 } };
const delivery = { v: 1, delivery: 'wake', original: { sourceSessionId: 'source', sourceMessage: witness.sourceMessage },
  event: { kind: 'update_posted' } };
const request = { v: 1, producer: 'sessionAction', permission: {},
  sourceSession: { sourceSessionId: 'source', sourceTurnId: 'turn', via: 'action' }, followDeliveryV1: delivery };

describe('protected source-selected Follow input', () => {
  it('uses current Run permission identities for attention and withdraws them without a terminal cursor', () => {
    expect(SessionFollowInputV1Schema.safeParse({ v: 1, delivery: 'wake', original: {
      source: { kind: 'execution_run', sessionId: 'source', runId: 'run-a' }, permissionRequests: [{ requestId: 'request-a', createdAt: 1 }] },
      event: { kind: 'needs_you', type: 'approval' } }).success).toBe(true);
    const frontier = { sessionId: 'source', runId: 'run-a', status: 'running', terminalEventId: null,
      attention: { kind: 'permission_required', requestIds: ['request-b', 'request-a'],
        requests: [{ requestId: 'request-b', createdAt: 2 }, { requestId: 'request-a', createdAt: 1 }] } } as const;
    const occurrence = resolveExecutionRunFollowOccurrenceV1(frontier);
    expect(occurrence).toEqual({ original: { source: { kind: 'execution_run', sessionId: 'source', runId: 'run-a' },
      permissionRequests: [{ requestId: 'request-a', createdAt: 1 }, { requestId: 'request-b', createdAt: 2 }] }, event: { kind: 'needs_you', type: 'approval' } });
    const delivery = SessionFollowInputV1Schema.parse({ v: 1, ...occurrence, delivery: 'wake' });
    if (!('permissionRequests' in delivery.original)) throw new Error('Missing exact permission original');
    expect(deriveSessionFollowOriginalOccurrenceKeyV1(delivery.original)).toBe(deriveSessionFollowOriginalOccurrenceKeyV1({
      ...delivery.original, permissionRequests: delivery.original.permissionRequests.map(request => ({ createdAt: request.createdAt, requestId: request.requestId })),
    }));
    expect(deriveSessionFollowOriginalOccurrenceKeyV1(delivery.original)).toBe(
      deriveSessionFollowOriginalOccurrenceKeyV1(resolveExecutionRunFollowOccurrenceV1({ ...frontier,
        attention: { ...frontier.attention, requests: [...frontier.attention.requests].reverse() } })!.original));
    expect(deriveSessionFollowOriginalOccurrenceKeyV1(delivery.original)).not.toBe(
      deriveSessionFollowOriginalOccurrenceKeyV1(resolveExecutionRunFollowOccurrenceV1({ ...frontier,
        attention: { ...frontier.attention, requests: [{ requestId: 'request-a', createdAt: 3 }, { requestId: 'request-b', createdAt: 2 }] } })!.original));
    expect(resolveExecutionRunFollowOccurrenceV1({ ...frontier, attention: undefined })).toBeNull();
    expect(resolveExecutionRunFollowOccurrenceV1({ ...frontier, attention: { kind: 'permission_required', requestIds: [] } })).toBeNull();
    expect(SessionFollowInputV1Schema.safeParse({ ...delivery, original: { ...delivery.original, terminalEventId: 'fake' } }).success).toBe(false);
    expect(SessionFollowInputV1Schema.safeParse({ ...delivery, event: { kind: 'finished' } }).success).toBe(false);
    expect(SessionFollowInputV1Schema.safeParse({ ...delivery, original: { source: { kind: 'execution_run', sessionId: 'source', runId: 'run-a' },
      terminalEventId: 'terminal' } }).success).toBe(false);
  });
  it('retains exact Run relation custody on stored reads and never downgrades a malformed Run to a Session follower', () => {
    const relations = SessionFollowRelationWitnessesV1Schema.parse([
      { relation: 'follower', source: { kind: 'workflow_run', runId: 'workflow' }, attachedAt: 1, expectedRevision: 2 },
      { relation: 'follower', source: { kind: 'execution_run', sessionId: 'source', runId: 'run' },
        attachedAt: 1, expectedTerminalEventId: null },
    ]);
    expect(createStoredReadSchema(SessionFollowRelationWitnessesV1Schema).parse(relations)).toEqual(relations);
    expect(createStoredReadSchema(SessionFollowRelationWitnessesV1Schema).safeParse([
      { ...relations[0], source: { kind: 'unknown_run', runId: 'workflow' } },
    ]).success).toBe(false);
    expect(createStoredReadSchema(SessionFollowRelationWitnessesV1Schema).parse([{ relation: 'follower' }]))
      .toEqual([{ relation: 'follower' }]);
  });
  it('requires needs_you to name a current request original, never an immutable message', () => {
    for (const type of ['decision', 'approval', 'blocked'] as const) {
      const event = { kind: 'needs_you', type, mode: 'wait', handling: 'person' };
      expect(SessionFollowInputV1Schema.safeParse({ ...delivery, event }).success).toBe(false);
      expect(SessionInputRequestV1Schema.safeParse({ ...request, followDeliveryV1: { ...delivery, event } }).success).toBe(false);
      expect(SessionFollowInputV1Schema.safeParse({ v: 1, delivery: 'wake', original: {
        sourceSessionId: 'source', sourceRequests: { agentStateVersion: 4,
          requests: [{ requestId: 'live-question', createdAt: 3, turnId: 'turn' }] },
      }, requestEvents: [{ requestId: 'live-question', event }] }).success).toBe(true);
    }
    for (const kind of FOLLOW_EVENT_KINDS_V1) {
      if (kind !== 'needs_you') expect(SessionFollowInputV1Schema.safeParse({ ...delivery, event: { kind } }).success).toBe(true);
    }
  });
  it('indexes immutable originals, never the mutable request snapshot or selected route', () => {
    const request = { requestId: 'question', createdAt: 3, turnId: 'turn' };
    const original = { sourceSessionId: 'source', sourceRequests: { agentStateVersion: 1, requests: [request] } };
    const key = deriveSessionFollowOriginalOccurrenceKeyV1(original);
    expect(key).toBeTruthy();
    expect(deriveSessionFollowOriginalOccurrenceKeyV1({ ...original, sourceRequests: {
      agentStateVersion: 7, requests: [request] } })).toBe(key);
    expect(deriveSessionFollowOriginalOccurrenceKeyV1({ ...original, sourceSessionId: 'other' })).not.toBe(key);
    expect(deriveSessionFollowOriginalOccurrenceKeyV1({ ...original, sourceRequests: {
      agentStateVersion: 7, requests: [request, { ...request, requestId: 'other' }] } })).toBeNull();
  });
  it('keeps exact Run originals distinct from their parent Session and from later Run results', () => {
    const execution = { source: { kind: 'execution_run', sessionId: 'source', runId: 'run-a' }, terminalEventId: 'terminal-1' } as const;
    const workflow = { source: { kind: 'workflow_run', runId: 'workflow-a' }, revision: 4 } as const;
    const executionDelivery = { v: 1, delivery: 'wake', original: execution, event: { kind: 'failed_or_stopped' } };
    const workflowDelivery = { v: 1, delivery: 'next_turn', original: workflow, event: { kind: 'finished' } };
    expect(SessionFollowInputV1Schema.safeParse(executionDelivery).success).toBe(true);
    expect(SessionFollowInputV1Schema.safeParse(workflowDelivery).success).toBe(true);
    expect(deriveSessionFollowOriginalOccurrenceKeyV1(execution)).not.toBe(
      deriveSessionFollowOriginalOccurrenceKeyV1({ sourceSessionId: 'source', sourceMessage: { localId: 'terminal-1', seq: 4 } }));
    expect(deriveSessionFollowOriginalOccurrenceKeyV1(execution)).not.toBe(
      deriveSessionFollowOriginalOccurrenceKeyV1({ ...execution, terminalEventId: 'terminal-2' }));
    expect(deriveSessionFollowOriginalOccurrenceKeyV1(workflow)).not.toBe(
      deriveSessionFollowOriginalOccurrenceKeyV1({ ...workflow, revision: 5 }));
    expect(SessionInputRequestV1Schema.safeParse({ ...request, sourceSession: undefined, followDeliveryV1: executionDelivery }).success).toBe(true);
    expect(SessionInputRequestV1Schema.safeParse({ ...request, followDeliveryV1: executionDelivery }).success).toBe(false);
    expect(SessionFollowInputV1Schema.safeParse({ ...executionDelivery, original: { ...execution, revision: 4 } }).success).toBe(false);
  });
  it('uses only exact input custody for native rule observation, source projection and ACK', () => {
    const frontier = { transcriptSeq: 0, readyEventSeq: 0, agentStateVersion: 0, turn: null };
    expect(SessionFollowObservePendingRequestV1Schema.safeParse({ v: 1, sessionId: 'receiver', inputLocalIds: ['input'] }).success).toBe(true);
    expect(SessionFollowObservePendingRequestV1Schema.safeParse({ v: 1, sessionId: 'receiver',
      ruleInputs: [{ localInputId: 'input', sources: [witness] }] }).success).toBe(false);
    expect(SessionFollowPendingObservationV1Schema.safeParse({ kind: 'admitted_input', localInputId: 'input', sourceSessionId: 'source',
      destinationSessionId: 'receiver', delivered: frontier, observed: { ...frontier, transcriptSeq: 3 }, delivery }).success).toBe(true);
    expect(SessionFollowSourceProjectionRequestV1Schema.safeParse({ v: 1, sourceSessionId: 'source', localInputId: 'input',
      afterTranscriptSeq: 2, observedTranscriptSeq: 3, limit: 1 }).success).toBe(true);
    expect(SessionFollowSourceProjectionRequestV1Schema.safeParse({ v: 1, sourceSessionId: 'source', rule: witness.rule,
      afterTranscriptSeq: 2, observedTranscriptSeq: 3, limit: 1 }).success).toBe(false);
    expect(SessionFollowAcknowledgeRequestV1Schema.safeParse({ v: 1, destinationSessionId: 'receiver', sourceSessionId: 'source',
      localInputId: 'input', expectedPublisherGeneration: '1', expected: frontier, observed: frontier, consumed: frontier,
      acceptance: { kind: 'admitted_input', localInputId: 'input', userMessageSeq: null } }).success).toBe(true);
    const parsed = SessionInputRequestV1Schema.parse(request);
    expect(() => assertSessionInputAdmissionReceiptForRequestV1({ request: parsed, inputAdmissionReceipt: {
      v: 1, issuer: 'authenticatedMachine', followDeliveryV1: delivery,
      admittedTarget: { homeId: 'home', accountId: 'alice', sessionId: 'receiver', machineId: 'receiver-machine', installationId: 'receiver-install' },
    } })).not.toThrow();
  });
  it('retains public original notice intent without publishing private rule or policy refs in either Session', () => {
    expect(SessionInputRequestV1Schema.safeParse(request).success).toBe(true);
  });
  it('accepts a server-admitted Account Follow receipt without granting generic source provenance', () => {
    const parsed = SessionInputRequestV1Schema.parse({ ...request, sourceSession: undefined });
    const receipt = { v: 1, issuer: 'authenticatedAccount', actorAccountId: 'alice', sessionRelationship: 'owner',
      followDeliveryV1: delivery, admittedTarget: { homeId: 'home', accountId: 'alice', sessionId: 'receiver', machineId: 'foreign-machine', installationId: 'install' } };
    expect(() => assertSessionInputAdmissionReceiptForRequestV1({ request: parsed, inputAdmissionReceipt: receipt })).not.toThrow();
    const provenance = settleSessionMessageProvenanceV1({ request: parsed, inputAdmissionReceipt: receipt,
      requestedProvenance: { v: 1, kind: 'happierApp', actor: { kind: 'owner' } } });
    expect(provenance).toEqual({ v: 1, kind: 'host', producer: 'sessionAction' });
    expect(isAuthoritativeHumanSessionFollowMessageV1({ provenance })).toBe(false);
    expect(() => assertSessionInputAdmissionReceiptForRequestV1({ request: SessionInputRequestV1Schema.parse(request), inputAdmissionReceipt: receipt })).toThrow();
    expect(() => assertSessionInputAdmissionReceiptForRequestV1({ request: SessionInputRequestV1Schema.parse({
      ...request, followDeliveryV1: undefined }), inputAdmissionReceipt: receipt })).toThrow();
  });
  it('refuses an unrelated causal source or private rule/policy fields in the shared body', () => {
    expect(SessionInputRequestV1Schema.safeParse({ ...request,
      sourceSession: { ...request.sourceSession, sourceSessionId: 'other-source' } }).success).toBe(false);
    expect(SessionInputRequestV1Schema.safeParse({ ...request, followDeliveryV1: { ...delivery,
      rules: [witness.rule], policy: { preset: 'important' } } }).success).toBe(false);
  });
  it('requires the exact original source receipt, not a fabricated private marker or unrelated accepted input', () => {
    const parsed = SessionInputRequestV1Schema.parse(request);
    const receipt = { v: 1, issuer: 'authenticatedMachine', followSources: [witness], followDeliveryV1: delivery,
      admittedTarget: { homeId: 'home', accountId: 'alice', sessionId: 'receiver', machineId: 'receiver-machine', installationId: 'receiver-install' } };
    expect(assertSessionInputAdmissionReceiptForRequestV1({ request: parsed, inputAdmissionReceipt: receipt })).toMatchObject(receipt);
    for (const invalid of [{ v: 1, issuer: 'authenticatedMachine' },
      { ...receipt, followSources: [{ ...witness, sourceMessage: { ...witness.sourceMessage, seq: 4 } }] },
      { ...receipt, followDeliveryV1: { ...delivery, delivery: 'next_turn' } },
      { ...receipt, admittedTarget: { ...receipt.admittedTarget, sessionId: 'other-receiver' } }]) {
      expect(() => assertSessionInputAdmissionReceiptForRequestV1({ request: parsed, inputAdmissionReceipt: invalid })).toThrow();
    }
  });
  it('requires every selected active original request in a source snapshot, never an aggregate strongest event', () => {
    const original = { sourceSessionId: 'source', sourceRequests: { agentStateVersion: 4,
      requests: [{ requestId: 'approval', createdAt: 1 }, { requestId: 'question', createdAt: 2 }] } };
    const requestEvents = [{ requestId: 'approval', event: { kind: 'needs_you', type: 'approval' } },
      { requestId: 'question', event: { kind: 'needs_you', type: 'blocked', mode: 'continue' } }];
    const marker = { v: 1, delivery: 'wake', original, requestEvents };
    expect(SessionInputRequestV1Schema.safeParse({ ...request, followDeliveryV1: marker }).success).toBe(true);
    expect(SessionInputRequestV1Schema.safeParse({ ...request, followDeliveryV1: { ...marker, requestEvents: requestEvents.slice(0, 1) } }).success).toBe(false);
  });
});
