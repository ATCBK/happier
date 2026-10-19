import { useState } from 'react';
import { usePluginHostApi } from '@happier-dev/plugin-ui';
import { DocEditProposal, Text, type DocEditProposalState } from '@happier-dev/plugin-ui/components';

import { requestExternalDocAcceptance, requestExternalDocDecline } from './docReview.js';

const proposalRef = { kind: 'discussion', discussion: { serverId: 'home', discussionId: 'd1' }, messageId: 'm1' } as const;
const base = { headerVersion: 3, bodyVersion: 14 } as const;

/**
 * A plugin's own Doc review: it reads the suggestion and draws the shared card. Accept and Decline
 * call the Doc Actions, so the host's approval (the person) still decides; the card never does.
 */
export function DocEditProposalExample() {
  const api = usePluginHostApi();
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
  const [outcome, setOutcome] = useState<'accepted' | 'declined' | 'refused' | null>(null);
  const decide = async (kind: 'accept' | 'decline') => {
    setBusy(kind);
    // A refused or unapproved decision rejects; only the Action's answer settles the card.
    const decided = await (kind === 'accept'
      ? requestExternalDocAcceptance(api, { proposalRef, expectedRevision: base })
      : requestExternalDocDecline(api, { proposalRef })).then(() => true, () => false);
    setBusy(null);
    setOutcome(decided ? kind === 'accept' ? 'accepted' : 'declined' : 'refused');
  };
  const decision: DocEditProposalState = outcome === 'accepted' || outcome === 'declined'
    ? { state: 'settled', receipt: { testID: `author-proposal.${outcome}`, mark: outcome,
      text: outcome === 'accepted' ? 'You accepted the edit · now version 15' : 'You declined the suggestion' } }
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
    {outcome ? <Text value={`Outcome ${outcome}`} /> : null}
  </>;
}
