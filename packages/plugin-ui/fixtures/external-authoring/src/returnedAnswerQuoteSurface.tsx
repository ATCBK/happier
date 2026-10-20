import { useState } from 'react';
import { ReturnedAnswerQuote, Text, type ReturnedAnswerQuestion } from '@happier-dev/plugin-ui/components';

/** The answering session's identity, the exact question read and navigation remain with the author. */
export function ReturnedAnswerQuoteExample() {
  const [questionOpen, setQuestionOpen] = useState(false);
  const [question, setQuestion] = useState<ReturnedAnswerQuestion>({ status: 'unavailable', onRetry: () =>
    setQuestion({ status: 'asked', onOpen: () => setOpened('question') }) });
  const [opened, setOpened] = useState('');
  return <>
    <ReturnedAnswerQuote testID="author-answer" answerer="Checkout UI retry states" outcome="answer"
      onOpenAnswerer={() => setOpened('answerer')}
      question={{ open: questionOpen, onToggle: () => setQuestionOpen(open => !open), state: question }}>
      <Text value="A replayed charge shows Payment confirmed." />
    </ReturnedAnswerQuote>
    <ReturnedAnswerQuote testID="author-failed" answerer="Support runbook" outcome="failed" />
    {opened ? <Text value={`Opened ${opened}`} /> : null}
  </>;
}
