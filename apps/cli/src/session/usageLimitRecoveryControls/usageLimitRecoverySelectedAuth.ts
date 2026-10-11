import {
  ConnectedAccountServiceKeyIngressSchema,
  ConnectedServiceBindingsV2IngressSchema,
} from '@happier-dev/protocol/connect/connected-service-bindings';
import type {
  ConnectedAccountServiceKey,
  SessionRuntimeIssueV1,
  SessionUsageLimitRecoveryV1,
} from '@happier-dev/protocol';

function readServiceId(value: unknown): ConnectedAccountServiceKey | null {
  const parsed = ConnectedAccountServiceKeyIngressSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function resolveUsageLimitRecoverySelectedAuthFromIssue(input: Readonly<{
  issue: SessionRuntimeIssueV1;
  defaultNativeServiceId?: ConnectedAccountServiceKey | null;
  requiredConnectedServiceId?: ConnectedAccountServiceKey | null;
  /** Null means known absence; omission cannot establish native quota-source identity. */
  connectedServices?: unknown;
}>): SessionUsageLimitRecoveryV1['selectedAuth'] | null {
  const connectedService = input.issue.usageLimit?.connectedService;
  const issueServiceId = readServiceId(connectedService?.serviceId);
  if (input.requiredConnectedServiceId && issueServiceId !== readServiceId(input.requiredConnectedServiceId)) {
    return null;
  }
  const serviceId = issueServiceId ?? readServiceId(input.defaultNativeServiceId);
  const groupId = connectedService?.groupId ?? null;
  const profileId = connectedService?.profileId ?? null;
  if (groupId && serviceId) {
    return { kind: 'group', serviceId, groupId, profileId };
  }

  const bindings = input.connectedServices === undefined ? null : ConnectedServiceBindingsV2IngressSchema.safeParse(
    input.connectedServices ?? { v: 2, bindingsByServiceId: {} },
  );
  const binding = bindings?.success && serviceId ? bindings.data.bindingsByServiceId[serviceId] : null;
  // The 0.2 quota producer used native:<48 lowercase hex> as a local credential
  // source id. This is retained-data interpretation, not a current profile namespace.
  const nativeQuotaSource = profileId && /^native:[a-f0-9]{48}$/u.test(profileId)
    && bindings?.success
    && !(binding?.source === 'connected' && binding.selection === 'profile' && binding.profileId === profileId);
  if (profileId && serviceId && !nativeQuotaSource) {
    return { kind: 'profile', serviceId, profileId };
  }
  return serviceId ? { kind: 'native', serviceId } : { kind: 'native' };
}
