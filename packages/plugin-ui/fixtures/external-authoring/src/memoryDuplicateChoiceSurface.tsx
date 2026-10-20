import { useState } from 'react';
import {
  Button, MemoryDuplicateChoice, Text,
  type MemoryDuplicateCandidate, type MemoryDuplicateChoiceKind,
} from '@happier-dev/plugin-ui/components';

const candidates: readonly MemoryDuplicateCandidate[] = [
  { id: 'saved-retry', text: 'Retry payment webhooks 3 times', meta: 'Same fact · Payments' },
  { id: 'saved-backoff', text: 'Back off 400 ms between webhook retries', meta: 'Related · Payments' },
];

/** The author found the candidates and owns the save; the shared comparison only reports the choice. */
export function MemoryDuplicateChoiceExample(props: Readonly<{
  onSave?: (choice: Readonly<{ kind: MemoryDuplicateChoiceKind; factId: string | null }>) => void;
}>) {
  const [choice, setChoice] = useState<MemoryDuplicateChoiceKind>('update');
  const [candidateId, setCandidateId] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  return <>
    <MemoryDuplicateChoice testID="author-duplicate" candidates={candidates}
      newText="Retry payment webhooks 5 times during deploys" candidateId={candidateId}
      onCandidateChange={setCandidateId} choice={choice} onChoiceChange={setChoice} />
    <Button title="Save" onPress={() => {
      const factId = choice === 'keep_both' ? null : candidateId ?? candidates[0]!.id;
      props.onSave?.({ kind: choice, factId });
      setSaved(`${choice}:${factId ?? 'none'}`);
    }} />
    {saved ? <Text value={`Saved ${saved}`} /> : null}
  </>;
}
