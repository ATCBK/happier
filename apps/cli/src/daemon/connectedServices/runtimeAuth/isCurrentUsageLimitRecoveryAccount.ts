import type { ConnectedServiceRuntimeFailureClassification } from './types';

/** A saved account reset cannot authorize a relinked account or another retry owner. */
export function isCurrentUsageLimitRecoveryAccount(input: Readonly<{
  classification: ConnectedServiceRuntimeFailureClassification;
  providerAccountId: string | null;
  providerOrganizationId?: string | null;
  requiresProviderOrganizationId?: boolean;
  credentialRevision: string | null;
}>): boolean {
  const failure = input.classification;
  if (failure.kind !== 'usage_limit' || failure.groupId !== null || failure.quotaScope !== 'account') return false;
  if (failure.sourceProviderAccountId) {
    if (input.providerAccountId !== failure.sourceProviderAccountId) return false;
    if (failure.sourceProviderOrganizationId) {
      return input.providerOrganizationId === failure.sourceProviderOrganizationId;
    }
    if (!input.requiresProviderOrganizationId) return true;
  }
  return Boolean(failure.expectedCredentialRevision && input.credentialRevision === failure.expectedCredentialRevision);
}
