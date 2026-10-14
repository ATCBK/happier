import { useState } from 'react';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import {
  Button, HappierMemoryFactRow, Item, ItemGroup, Text,
  type HappierMemoryFactRowProps,
} from '@happier-dev/plugin-ui/components';

/** Plugin-owned facts; fetching, mutation and source navigation belong to the author. */
export function MemoryFactsExample() {
  const [opened, setOpened] = useState<string | null>(null);
  const fact = {
    testID: 'author-memory-fact',
    text: 'Prefer small patches',
    metadata: 'Oct 14 · Until Nov 14',
    source: {
      label: 'Review session',
      accessibilityLabel: 'Open source session',
      onPress: () => setOpened('source'),
    },
    actions: <Button title="Edit fact" variant="plain" onPress={() => setOpened('edit')} />,
  } satisfies HappierMemoryFactRowProps;
  return <ItemGroup title="Memory">
    <HappierMemoryFactRow {...fact} />
    {/* Topics already use public navigation rows; no memory storage/parser API is implied. */}
    <Item title="Review habits" subtitle="How we review patches"
      accessibilityLabel="Open review habits" onPress={() => setOpened('topic')} />
    {opened ? <Text value={`Opened ${opened}`} /> : null}
  </ItemGroup>;
}

export const renderSurface = defineUiSurface(MemoryFactsExample);
