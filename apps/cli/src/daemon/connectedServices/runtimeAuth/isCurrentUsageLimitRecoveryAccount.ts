import type { ConnectedServiceRuntimeFailureClassification } from './types';

/** A saved account reset cannot authorize a relinked account or another retry owner. */
export function isCurrentUsageLimitRecoveryAccount(input: Readonly<{
  classification: ConnectedServiceRuntimeFailureClassification;
  providerAccountId: string | null;
  credentialRevision: string | null;
}>): boolean {
  const failure = input.classification;
  if (failure.kind !== 'usage_limit' || failure.groupId !== null || failure.quotaScope !== 'account') return false;
  return failure.sourceProviderAccountId
    ? input.providerAccountId === failure.sourceProviderAccountId
    : Boolean(failure.expectedCredentialRevision && input.credentialRevision === failure.expectedCredentialRevision);
}
