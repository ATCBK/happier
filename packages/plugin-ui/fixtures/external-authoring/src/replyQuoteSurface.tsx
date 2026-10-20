import { useState } from 'react';
import { Button, ReplyQuote, Text } from '@happier-dev/plugin-ui/components';

/** All identities, source reads and navigation remain with the author. */
export function ReplyQuoteExample() {
  const [available, setAvailable] = useState(true);
  const [opened, setOpened] = useState('');
  return <>
    <ReplyQuote testID="author-message-quote" kind="message" source={{ state: 'available',
      label: 'Mara', text: 'Keep the original question.', onPress: () => setOpened('message') }} />
    <ReplyQuote testID="author-doc-quote" kind="doc_passage" source={available
      ? { state: 'available', label: 'Release notes', text: 'Private selected passage.', detail: 'Revision 3',
        onPress: () => setOpened('document') }
      : { state: 'unavailable', label: 'Document passage', reason: 'Source unavailable' }} />
    <ReplyQuote testID="author-task-quote" kind="task" source={{ state: 'available',
      label: 'Retry budget', text: 'In progress', onPress: () => setOpened('task') }} />
    <Button title="Withdraw document source" onPress={() => setAvailable(false)} />
    {opened ? <Text value={`Opened ${opened}`} /> : null}
  </>;
}
