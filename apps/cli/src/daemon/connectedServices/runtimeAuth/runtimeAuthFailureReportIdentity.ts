import type { ConnectedServiceRuntimeFailureClassification } from './types';

// Both report keys must identify the selected credential that actually failed.
// Their remaining fields belong to their separate delivery/dedupe contracts.
export function readRuntimeAuthFailureReportSourceIdentity(
  classification: ConnectedServiceRuntimeFailureClassification,
) {
  return {
    serviceId: classification.serviceId,
    ...(classification.runtimeIssueFingerprint ? { runtimeIssueFingerprint: classification.runtimeIssueFingerprint } : {}),
    ...(classification.sourceProviderOrganizationId
      ? { sourceProviderOrganizationId: classification.sourceProviderOrganizationId } : {}),
    profileId: classification.profileId,
    groupId: classification.groupId,
    groupGeneration: classification.groupGeneration ?? null,
    expectedCredentialRevision: classification.expectedCredentialRevision ?? null,
  };
}
