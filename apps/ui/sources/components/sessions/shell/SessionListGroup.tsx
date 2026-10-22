import * as React from 'react';
import { Platform, useWindowDimensions, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useIsTablet } from '@/utils/platform/responsive';
import { Eyebrow } from '@/components/ui/text/Eyebrow';
import { Text } from '@/components/ui/text/Text';

import {
  resolveSessionListDensityViewState,
  resolveSessionListItemDensity,
  resolveSessionListRowIdentityMetrics,
  resolveSessionListRowTitleTextMetrics,
  SESSION_LIST_ROW_CORNER_RADIUS,
  type SessionListRowDensity,
} from './resolveSessionListDensityViewState';
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

/** One geometry for every row of a session-list group's sheet: its rows and its "Show …" row. */
export function resolveSessionListGroupRowGeometry(
  density: SessionListRowDensity,
  window: Readonly<{ isTablet: boolean; windowWidth: number }>,
) {
  const itemDensity = resolveSessionListItemDensity(density);
  const densityViewState = resolveSessionListDensityViewState(
    density === 'minimal' ? 'narrow' : density === 'compact' ? 'cozy' : 'comfortable',
    { isTablet: window.isTablet, platform: Platform.OS, windowWidth: window.windowWidth },
  );
  const readableNativePhoneMinimal = density === 'minimal'
    && densityViewState.rowHeight !== resolveSessionListDensityViewState('narrow').rowHeight;
  const titleTextMetrics = resolveSessionListRowTitleTextMetrics({ density, readableNativePhoneMinimal });
  return { itemDensity, densityViewState, readableNativePhoneMinimal, titleTextMetrics };
}

/**
 * A group's last row when it lists only its first few (Drafts, Scheduled): a full-height row at the
 * list's density, quiet, on the rows' title edge, that reveals the rest.
 */
export const SessionListGroupMoreRow = React.memo(function SessionListGroupMoreRow(props: Readonly<{
  testID: string;
  title: string;
  density: SessionListRowDensity;
  onPress: () => void;
}>) {
  const { theme } = useUnistyles();
  const isTablet = useIsTablet();
  const { width: windowWidth } = useWindowDimensions();
  const { itemDensity, densityViewState, readableNativePhoneMinimal, titleTextMetrics } =
    resolveSessionListGroupRowGeometry(props.density, { isTablet, windowWidth });
  const identityMetrics = resolveSessionListRowIdentityMetrics({ density: props.density, readableNativePhoneMinimal });
  return (
    <Item
      testID={props.testID}
      title={props.title}
      density={itemDensity}
      style={{ height: densityViewState.rowHeight, minHeight: densityViewState.rowHeight, paddingVertical: 0 }}
      titleStyle={[titleTextMetrics, { color: theme.colors.text.secondary }]}
      // Minimal rows lead with the agent mark; an empty slot of its size keeps this title on theirs.
      leftElement={props.density === 'minimal' ? (
        <View style={{ width: identityMetrics.agentLogoSize, height: identityMetrics.agentLogoSize }} />
      ) : undefined}
      showChevron={false}
      onPress={props.onPress}
    />
  );
});

const stylesheet = StyleSheet.create(() => ({
  // The next group's label brings its own top padding (`SESSION_LIST_COLUMN_METRICS`).
  section: { width: '100%' },
  group: { borderRadius: SESSION_LIST_ROW_CORNER_RADIUS },
  headerTitleRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
}));
