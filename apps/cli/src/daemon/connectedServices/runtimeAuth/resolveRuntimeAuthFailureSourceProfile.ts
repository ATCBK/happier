import type { ConnectedServiceRuntimeFailureClassification } from './types';
import { resolveConnectedServiceGroupMemberByProviderAccountId, type ConnectedServiceGroupMemberProviderAccountIdentity } from '../shared/resolveConnectedServiceGroupMemberByProviderAccountId';

type RuntimeAuthFailureGroupMember = Readonly<{ profileId: string }>;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export async function resolveRuntimeAuthFailureSourceProfile(input: Readonly<{
  classification: ConnectedServiceRuntimeFailureClassification;
  requiresProviderOrganizationId?: boolean;
  getGroupMembers: () => Promise<readonly RuntimeAuthFailureGroupMember[] | null>;
  resolveProviderAccountIdentity: (profileId: string) => Promise<ConnectedServiceGroupMemberProviderAccountIdentity | null>;
}>): Promise<ConnectedServiceRuntimeFailureClassification> {
  const groupId = readNonEmptyString(input.classification.groupId);
  const sourceProviderAccountId = readNonEmptyString(input.classification.sourceProviderAccountId);
  if (!groupId) return input.classification;
  const unattributed = { ...input.classification, profileId: null, groupGeneration: null, expectedCredentialRevision: null };
  if (input.classification.kind === 'usage_limit' && input.requiresProviderOrganizationId
    && !readNonEmptyString(input.classification.sourceProviderOrganizationId)) return unattributed;
  if (!sourceProviderAccountId) return input.classification;
  let members: readonly RuntimeAuthFailureGroupMember[] | null;
  try {
    members = await input.getGroupMembers();
  } catch {
    return unattributed;
  }
  if (!members?.length) return unattributed;

  const sourceProfileId = await resolveConnectedServiceGroupMemberByProviderAccountId({
    providerAccountId: sourceProviderAccountId,
    providerOrganizationId: input.classification.sourceProviderOrganizationId,
    members,
    resolveProviderAccountIdentity: input.resolveProviderAccountIdentity,
  });
  if (!sourceProfileId) return unattributed;
  if (sourceProfileId === readNonEmptyString(input.classification.profileId)) return input.classification;
  return {
    ...input.classification,
    profileId: sourceProfileId,
    groupGeneration: null,
    expectedCredentialRevision: null,
  };
}
