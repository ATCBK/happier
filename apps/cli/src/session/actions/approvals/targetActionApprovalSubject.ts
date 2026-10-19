import type { TargetActionApprovalRequestV1 } from '@happier-dev/protocol';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function subject(request: TargetActionApprovalRequestV1): unknown {
  return {
    v: request.v,
    kind: request.kind,
    createdAtMs: request.createdAtMs,
    createdBy: request.createdBy,
    requestedSurface: request.requestedSurface,
    qualifiedActionId: request.qualifiedActionId,
    input: request.input,
    secretInputPaths: request.secretInputPaths,
    secretInputLabels: request.secretInputLabels,
    approvalInputCustody: request.approvalInputCustody,
    accountId: request.accountId,
    resourceId: request.resourceId,
    sourceCustody: request.sourceCustody,
    policyFingerprint: request.policyFingerprint,
    subjectFingerprint: request.subjectFingerprint,
    replayPlacement: request.replayPlacement,
    executionOriginV1: request.executionOriginV1,
    requesterConfirmation: request.requesterConfirmation,
    summary: request.summary,
    detail: request.detail,
  };
}

export function targetActionApprovalSubjectsEqual(
  left: TargetActionApprovalRequestV1,
  right: TargetActionApprovalRequestV1,
): boolean {
  return stable(subject(left)) === stable(subject(right));
}

export function targetActionApprovalRequestsEqual(
  left: TargetActionApprovalRequestV1,
  right: TargetActionApprovalRequestV1,
): boolean {
  return stable(left) === stable(right);
}
