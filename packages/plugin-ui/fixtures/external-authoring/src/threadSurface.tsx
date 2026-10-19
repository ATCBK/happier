import { useState } from 'react';
import { Button, Text, ThreadMessage } from '@happier-dev/plugin-ui/components';

/** The author owns messages and selection; Happier owns their shared thread frame. */
export function ThreadExample() {
  const [selected, setSelected] = useState(false);
  return <>
    <ThreadMessage testID="author-thread-first" startsGroup selected={selected}
      face={<Text value="M" />}
      attribution={<Text value="Mara" />}
      trailing={<Button title="Select message" onPress={() => setSelected(value => !value)} />}>
      <Text value="Keep the original question with the answer." />
      <Text value="Waiting for the participant" />
    </ThreadMessage>
    <ThreadMessage testID="author-thread-next" startsGroup={false}
      face={<Text value="M" />} attribution={<Text value="Mara" />}>
      <Text value="And preserve the next message." />
    </ThreadMessage>
    {selected ? <Text value="Message selected" /> : null}
  </>;
}
