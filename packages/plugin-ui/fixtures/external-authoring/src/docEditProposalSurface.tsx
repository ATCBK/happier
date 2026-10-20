import { useState } from 'react';
import { usePluginHostApi } from '@happier-dev/plugin-ui';
import { DocEditProposal, Text, type DocEditProposalState } from '@happier-dev/plugin-ui/components';

import { requestExternalDocAcceptance, requestExternalDocDecline } from './docReview.js';

const proposalRef = { kind: 'discussion', discussion: { serverId: 'home', discussionId: 'd1' }, messageId: 'm1' } as const;
const base = { headerVersion: 3, bodyVersion: 14 } as const;
type ProposalDisposition = Awaited<ReturnType<typeof requestExternalDocAcceptance>>['docEditProposalDispositionV1'];

/**
 * A plugin's own Doc review: it reads the suggestion and draws the shared card. Accept and Decline
 * call the Doc Actions, so the host's approval (the person) still decides; the card never does.
 */
export function DocEditProposalExample() {
  const api = usePluginHostApi();
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
  const [outcome, setOutcome] = useState<ProposalDisposition | 'refused' | null>(null);
  const decide = async (kind: 'accept' | 'decline') => {
    setBusy(kind);
    // A refused or unapproved decision rejects; only the Action's answer settles the card.
    const decided = await (kind === 'accept'
      ? requestExternalDocAcceptance(api, { proposalRef, expectedRevision: base })
      : requestExternalDocDecline(api, { proposalRef })).then(result => result.docEditProposalDispositionV1, () => 'refused' as const);
    setBusy(null);
    setOutcome(decided);
  };
  const decision: DocEditProposalState = outcome && typeof outcome === 'object' && outcome.state !== 'open'
    ? { state: 'settled', receipt: { testID: `author-proposal.${outcome.state}`, mark: outcome.state,
      text: outcome.state === 'accepted'
        ? `Accepted by ${outcome.decidedBy.accountId} · now version ${outcome.acceptedRevision.bodyVersion}`
        : `Declined by ${outcome.decidedBy.accountId}` } }
    : {
      state: 'open', title: 'Suggested edit', basedOn: 'Based on version 14', reason: 'Replays are recorded once now.',
      footer: {
        kind: 'decide',
        status: busy ? { text: busy === 'accept' ? 'Accepting…' : 'Declining…', indicator: 'busy' }
          : outcome === 'refused' ? { text: 'Couldn’t save your decision. Try again.' }
            : { text: 'Version 14 · current', indicator: 'current', testID: 'author-proposal.current' },
        decline: { label: 'Decline', testID: 'author-proposal.decline', disabled: busy !== null, onPress: () => void decide('decline') },
        accept: { label: 'Accept', testID: 'author-proposal.accept', disabled: busy !== null, busy: busy === 'accept',
          onPress: () => void decide('accept') },
      },
    };
  return <>
    <DocEditProposal testID="author-proposal" before="Two rows." after="One row with a replayed badge." decision={decision} />
    {outcome ? <Text value={`Outcome ${typeof outcome === 'string' ? outcome : outcome.state}`} /> : null}
  </>;
}
