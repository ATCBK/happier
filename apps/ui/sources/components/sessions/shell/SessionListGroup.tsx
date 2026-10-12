import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Eyebrow } from '@/components/ui/text/Eyebrow';
import { Text } from '@/components/ui/text/Text';

import { SESSION_LIST_ROW_CORNER_RADIUS } from './resolveSessionListDensityViewState';
import { sessionListStyles } from './sessionListStyles';

/**
 * A titled group of the session list that is not a project group (Drafts, Scheduled): the same
 * sentence-case label and quiet count as a project group, then one sheet on the column's sheet edge.
 */
export const SessionListGroup = React.memo(function SessionListGroup(
  props: Readonly<{
    testID: string;
    headerTestID?: string;
    countTestID?: string;
    title: string;
    count: number;
    /** Rows the sheet counts for selection when its children are not plain items. */
    selectableItemCountOverride?: number;
    children: React.ReactNode;
    /** Below the sheet: a group-level state line (a failed read). */
    footer?: React.ReactNode;
  }>,
) {
  const headerStyles = sessionListStyles;
  return (
    <View testID={props.testID} style={stylesheet.section}>
      <View
        testID={props.headerTestID}
        style={headerStyles.groupHeaderSection}
        accessibilityRole="header"
        accessibilityLabel={`${props.title}, ${props.count}`}
      >
        <View style={stylesheet.headerTitleRow}>
          <Eyebrow style={headerStyles.groupHeaderTitle} numberOfLines={1}>
            {props.title}
          </Eyebrow>
          {props.count > 0 ? (
            <Text
              testID={props.countTestID}
              style={headerStyles.groupHeaderCount}
            >
              {props.count}
            </Text>
          ) : null}
        </View>
      </View>
      {React.Children.count(props.children) > 0 ? (
        <ItemGroup
          style={headerStyles.groupSheetUnderLabel}
          containerStyle={[stylesheet.group, headerStyles.groupSheetInset]}
          selectableItemCountOverride={props.selectableItemCountOverride}
        >
          {props.children}
        </ItemGroup>
      ) : null}
      {props.footer}
    </View>
  );
});

const stylesheet = StyleSheet.create(() => ({
  // The next group's label brings its own top padding (`SESSION_LIST_COLUMN_METRICS`).
  section: { width: '100%' },
  group: { borderRadius: SESSION_LIST_ROW_CORNER_RADIUS },
  headerTitleRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
}));
