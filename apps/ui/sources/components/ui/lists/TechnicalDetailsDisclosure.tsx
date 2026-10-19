import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import {
  ExpandableItem,
  ExpandableItemCaret,
} from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

export type TechnicalDetailsLine = Readonly<{
  key: string;
  label: string;
  value: string;
}>;

/**
 * The one "Technical details" disclosure: exact identifiers and codes, one tap away from the readable
 * page. The readable outcome leads the page; its code and raw cause wait here (approvals, Run steps).
 */
export function TechnicalDetailsDisclosure(
  props: Readonly<{
    title: string;
    lines: readonly TechnicalDetailsLine[];
    testID?: string;
  }>,
) {
  const [expanded, setExpanded] = React.useState(false);
  if (props.lines.length === 0) return null;
  return (
    <ExpandableItem
      testID={props.testID}
      expanded={expanded}
      onExpandedChange={setExpanded}
      showDivider={false}
      header={({ headerProps, expanded: open }) => (
        <Item
          {...headerProps}
          title={props.title}
          showChevron={false}
          rightElement={<ExpandableItemCaret expanded={open} />}
        />
      )}
    >
      {/* Quiet reference lines: a label, then its exact value in mono. */}
      <SectionContentRow>
        <View style={styles.lines}>
          {props.lines.map((line) => (
            <View key={line.key} style={styles.line}>
              <Text style={styles.label}>{line.label}</Text>
              <Text selectable style={styles.value}>
                {line.value}
              </Text>
            </View>
          ))}
        </View>
      </SectionContentRow>
    </ExpandableItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  lines: {
    gap: theme.space.s4,
  },
  line: {
    gap: 1,
  },
  label: {
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.tertiary,
  },
  value: {
    ...happierPageTextMetrics('rowDescription'),
    ...Typography.mono(),
    minWidth: 0,
    color: theme.colors.text.secondary,
  },
}));
