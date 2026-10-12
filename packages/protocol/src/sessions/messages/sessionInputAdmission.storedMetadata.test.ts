import { describe, expect, it } from 'vitest';

import {
  readSessionInputRequest,
  readSessionInputRequestV1,
  readSessionInputAuthority,
  readSessionInputAuthorityV1,
  readSessionMessageProvenance,
  readSessionMessageProvenanceV1,
  readSessionPermissionSourceAuthorityV1,
  readSessionInputCausalPermissionAuthorityV1,
  serializeSessionInputRequestEqualityIntentV1,
} from './sessionInputAdmission.js';
import { readParticipantRecipientRoutingIdentityV1 } from '../../messages/structured/participantMessageV1.js';
import { deriveSessionMessageAuthorAccountIdV1 } from './sessionMessageAccountActorV1.js';
import { deriveExternalShareableActorFromAdmissionReceiptV1 } from './sessionExternalShareableTranscriptV1.js';

describe('retained Session input metadata at canonical readers', () => {
  it('projects retained V1 authority without changing raw equality bytes or weakening fresh admission', () => {
    const request = {
      v: 1, producer: 'pluginSession', retired: true,
      caller: { kind: 'plugin', pluginId: 'example.channels', contributionLocalId: 'inbound', retired: true },
      sourceAuthority: { mediatorPluginId: 'example.channels', sourceRef: 'source', sourceRevisionOrEpoch: 'revision', remoteApprovalMaxScope: 'session', retired: true },
      permission: { requestedPermissionCeiling: 'read-only', retired: true },
    };
    const requestMeta = { happierInputRequestV1: request };
    const rawEquality = () => serializeSessionInputRequestEqualityIntentV1({ requestEnvelope: requestMeta, requestedAction: { v: 1, kind: 'enqueue' } });
    const before = rawEquality();
    const expectedRequest = {
      v: 1, producer: 'pluginSession',
      caller: { kind: 'plugin', pluginId: 'example.channels', contributionLocalId: 'inbound' },
      sourceAuthority: { mediatorPluginId: 'example.channels', sourceRef: 'source', sourceRevisionOrEpoch: 'revision', remoteApprovalMaxScope: 'session' },
      permission: { requestedPermissionCeiling: 'read-only' },
    };
    expect(readSessionInputRequest(requestMeta, 'stored')).toEqual(expectedRequest);
    expect(readSessionInputRequestV1(requestMeta, 'stored')).toEqual(expectedRequest);
    expect(readSessionInputRequest(requestMeta)).toBeNull();
    const authority = { ...request, permission: { ...request.permission, admittedPermissionCeiling: 'read-only' } };
    const authorityMeta = { happierInputAuthorityV1: authority };
    const expectedAuthority = { ...expectedRequest, permission: { requestedPermissionCeiling: 'read-only', admittedPermissionCeiling: 'read-only' } };
    expect(readSessionInputAuthority(authorityMeta, 'stored')).toEqual(expectedAuthority);
    expect(readSessionInputAuthorityV1(authorityMeta, 'stored')).toEqual(expectedAuthority);
    expect(readSessionInputAuthority(authorityMeta)).toBeNull();
    const expectedSource = {
      kind: 'mediatedExternal', mediatorPluginId: 'example.channels', sourceRef: 'source',
      sourceRevisionOrEpoch: 'revision', remoteApprovalMaxScope: 'session', admittedPermissionCeiling: 'read-only',
    };
    expect(readSessionPermissionSourceAuthorityV1(authorityMeta, 'stored')).toEqual(expectedSource);
    expect(readSessionInputCausalPermissionAuthorityV1(authorityMeta, 'stored')).toEqual({
      kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only', sourceAuthority: expectedSource,
    });
    expect(readSessionInputCausalPermissionAuthorityV1(authorityMeta)).toBeNull();
    expect(readSessionInputAuthority({ ...requestMeta, ...authorityMeta }, 'stored')).toBeNull();
    expect(readSessionInputRequest({ ...requestMeta, ...authorityMeta }, 'stored')).toBeNull();
    expect(readSessionInputAuthority({ happierInputAuthorityV1: { ...authority, sourceAuthority: { ...authority.sourceAuthority, mediatorPluginId: 'different.plugin' } } }, 'stored')).toBeNull();
    expect(readSessionInputAuthority({ happierInputAuthorityV1: { ...authority, permission: { admittedPermissionCeiling: 'unknown' } } }, 'stored')).toBeNull();
    expect(rawEquality()).toBe(before);
  });

  it('retains exact Workflow identity and descriptive provenance while rejecting malformed known facts', () => {
    const workflow = { purpose: 'invocation', runId: 'run-1', invocationRecordId: 'invocation-1', stepOrdinal: '2', retired: true };
    const request = { v: 2, producer: 'workflow', caller: { kind: 'host', retired: true }, workflow, permission: { requestedPermissionCeiling: 'read-only', retired: true }, retired: true };
    const expectedWorkflow = { purpose: 'invocation', runId: 'run-1', invocationRecordId: 'invocation-1', stepOrdinal: '2' };
    expect(readSessionInputRequest({ happierInputRequestV1: request }, 'stored')).toEqual({ v: 2, producer: 'workflow', caller: { kind: 'host' }, workflow: expectedWorkflow, permission: { requestedPermissionCeiling: 'read-only' } });
    expect(readSessionInputRequest({ happierInputRequestV1: { ...request, workflow: { ...workflow, runId: '' } } }, 'stored')).toBeNull();
    expect(readSessionInputAuthority({ happierInputAuthorityV1: { ...request, permission: { admittedPermissionCeiling: 'read-only' } } }, 'stored')).toEqual({ v: 2, producer: 'workflow', caller: { kind: 'host' }, workflow: expectedWorkflow, permission: { admittedPermissionCeiling: 'read-only' } });
    const provenance = { v: 2, kind: 'workflow_invocation', runId: 'run-1', invocationRecordId: 'invocation-1', stepOrdinal: '2', retired: true };
    expect(readSessionMessageProvenance({ happierProvenanceV1: provenance }, 'stored')).toEqual({ v: 2, kind: 'workflow_invocation', runId: 'run-1', invocationRecordId: 'invocation-1', stepOrdinal: '2' });
    expect(readSessionMessageProvenance({ happierProvenanceV1: provenance })).toBeNull();
    expect(readSessionMessageProvenance({ happierProvenanceV1: { ...provenance, stepOrdinal: '0' } }, 'stored')).toBeNull();
    const voice = { v: 1, kind: 'voice', retired: true };
    expect(readSessionMessageProvenanceV1({ happierProvenanceV1: voice }, 'stored')).toEqual({ v: 1, kind: 'voice' });
    expect(readSessionMessageProvenanceV1({ happierProvenanceV1: voice })).toBeNull();
    const predecessorOrigin = { happier: { conversationTurnOriginV1: {
      v: 1, channel: 'agent_thread', modality: 'text', retired: true,
      source: { pluginId: 'example.channels', contributionId: 'inbound', retired: true },
    } } };
    expect(readSessionMessageProvenanceV1(predecessorOrigin, 'stored')).toEqual({
      v: 1, kind: 'pluginSession', pluginId: 'example.channels', contributionLocalId: 'inbound', surface: 'unspecified',
    });
    expect(readSessionMessageProvenanceV1(predecessorOrigin)).toBeNull();
  });

  it('projects retained recipient routing without accepting malformed Run identity or fresh unknown fields', () => {
    const envelope = { kind: 'participant_message.v1', retired: true, payload: { retired: true, recipient: { kind: 'execution_run', runId: 'run-1', retired: true } } };
    expect(readParticipantRecipientRoutingIdentityV1({ happier: envelope }, 'stored')).toEqual({ kind: 'execution_run', runId: 'run-1' });
    expect(readParticipantRecipientRoutingIdentityV1({ happier: envelope })).toBeNull();
    expect(readParticipantRecipientRoutingIdentityV1({ happier: { ...envelope, payload: { recipient: { kind: 'execution_run', runId: ' ' } } } }, 'stored')).toBeNull();
    expect(readParticipantRecipientRoutingIdentityV1({ happier: { ...envelope, kind: 'unknown.v1' } }, 'stored')).toBeNull();
  });

  it('derives stored authenticated authors without admitting unknown issuer, role or Account identity', () => {
    const receipt = {
      v: 1, issuer: 'authenticatedAccount', actorAccountId: 'alice', sessionRelationship: 'sharedEditor', retired: true,
      admittedTarget: { homeId: 'home', accountId: 'alice', sessionId: 'session', machineId: 'machine', installationId: 'installation', retired: true },
    };
    expect(deriveSessionMessageAuthorAccountIdV1({ messageRole: 'user', inputAdmissionReceipt: receipt }, 'stored')).toBe('alice');
    expect(deriveSessionMessageAuthorAccountIdV1({ messageRole: 'user', inputAdmissionReceipt: receipt })).toBeNull();
    expect(deriveExternalShareableActorFromAdmissionReceiptV1(receipt, 'stored')).toBe('collaborator');
    expect(deriveExternalShareableActorFromAdmissionReceiptV1(receipt)).toBeNull();
    for (const malformed of [{ ...receipt, actorAccountId: ' ' }, { ...receipt, issuer: 'unknown' }, { ...receipt, sessionRelationship: 'viewer' }]) {
      expect(deriveSessionMessageAuthorAccountIdV1({ messageRole: 'user', inputAdmissionReceipt: malformed }, 'stored')).toBeNull();
      expect(deriveExternalShareableActorFromAdmissionReceiptV1(malformed, 'stored')).toBeNull();
    }
    expect(deriveSessionMessageAuthorAccountIdV1({ messageRole: 'agent', inputAdmissionReceipt: receipt }, 'stored')).toBeNull();
    expect(deriveSessionMessageAuthorAccountIdV1({ messageRole: 'user', inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine', actorAccountId: 'forged', retired: true } }, 'stored')).toBeNull();
  });
});
