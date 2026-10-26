import { readAccountNameFromLegacyProfileV1 } from '@happier-dev/protocol/account/accountDisplayProfileV1';
import * as React from 'react';

import type { PromptDocInstructionWriteFacts } from '@/components/approvals/promptDocApprovalModel';
import { Text } from '@/components/ui/text/Text';
import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getStorage, useSessionDisplayNameProjections } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { readableSessionDisplayTitle } from '@/utils/sessions/sessionDisplayTitle';

type Actor = NonNullable<PromptDocInstructionWriteFacts['provenance']['changedBy']>;

/**
 * An actor's display name through the existing identity owners: the signed-in Account's own profile,
 * another person's known profile, or an Agent's Session title read from its exact Home. Never an id,
 * never "you", never a placeholder: an actor this device cannot name yields null.
 */
export function usePromptDocActorName(actor: Actor | undefined, serverId: string): string | null {
  const accountId = actor?.kind === 'person' ? actor.accountId : null;
  const personName = getStorage()((state) => {
    if (!accountId) return null;
    const own = state.profileScope;
    if (own && own.accountId === accountId && areServerProfileIdentifiersEquivalent(own.serverId, serverId)) {
      return state.profile ? formatAccountDisplayName(state.profile) : null;
    }
    const user = state.users[accountId];
    return user ? formatAccountDisplayName({ name: readAccountNameFromLegacyProfileV1(user), username: user.username }) : null;
  });
  const agentAddresses = React.useMemo(
    () => actor?.kind === 'agent' && actor.sessionId ? [{ sessionId: actor.sessionId, serverId }] : [],
    [actor, serverId],
  );
  const [agentName] = useSessionDisplayNameProjections(agentAddresses, readableSessionDisplayTitle);
  return actor?.kind === 'agent' ? agentName ?? null : personName;
}

/**
 * Who changed the current revision and who approved it, as one quiet line (plan 61, lab `b-work A`
 * footer). Only evidence the document's receipts genuinely carry; an unnamed actor drops its clause.
 */
export const InstructionsProvenanceLine = React.memo(function InstructionsProvenanceLine(props: Readonly<{
  provenance: PromptDocInstructionWriteFacts['provenance'];
  serverId: string;
  style: React.ComponentProps<typeof Text>['style'];
  testID?: string;
}>): React.ReactElement | null {
  const changedBy = usePromptDocActorName(props.provenance.changedBy, props.serverId);
  const approvedBy = usePromptDocActorName(props.provenance.approvedBy, props.serverId);
  const clauses = [
    changedBy ? t('sessionInstructions.changedBy', { name: changedBy }) : null,
    approvedBy ? t(props.provenance.approvedBy?.decidedVia === 'voice'
      ? 'sessionInstructions.approvedByVoice' : 'sessionInstructions.approvedBy', { name: approvedBy }) : null,
  ].filter((clause): clause is string => clause !== null);
  if (clauses.length === 0) return null;
  return <Text testID={props.testID} style={props.style}>{clauses.join(' · ')}</Text>;
});
