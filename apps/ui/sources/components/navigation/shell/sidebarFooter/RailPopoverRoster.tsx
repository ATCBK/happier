import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
  ActionListSection,
  type ActionListItem,
} from '@/components/ui/lists/ActionListSection';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/** The header and the action rows beneath the list: what the list cannot have of the popover's height. */
const CHROME_HEIGHT_PX = 150;
/** A roster keeps a few rows visible however short the window is. */
const MIN_LIST_HEIGHT_PX = 160;

/** The height a rail roster's own list may take inside a popover of `maxHeight`. */
export function resolveRailPopoverRosterListMaxHeight(
  maxHeight: number,
): number {
  return Math.max(MIN_LIST_HEIGHT_PX, maxHeight - CHROME_HEIGHT_PX);
}

/**
 * The one anatomy of a rail roster popover (Bots, Machines): what it lists and a quiet summary of
 * those things on one line (or on a second header line), the list itself, a hairline, then the rows
 * that add to it. The list owns
 * its scrolling; size it with `resolveRailPopoverRosterListMaxHeight`.
 */
export function RailPopoverRoster(
  props: Readonly<{
    testID: string;
    title: string;
    /** What the listed things are doing, at the end of the title line. */
    summary?: React.ReactNode;
    /** A second header line under the title (Machines: presence and work counts, then All machines). */
    subheader?: React.ReactNode;
    children?: React.ReactNode;
    actions: ReadonlyArray<ActionListItem | null>;
  }>,
) {
  return (
    <View testID={props.testID}>
      <View style={styles.header}>
        <Text style={styles.title} accessibilityRole="header" numberOfLines={1}>
          {props.title}
        </Text>
        {props.summary}
      </View>
      {props.subheader ? (
        <View style={styles.subheader}>{props.subheader}</View>
      ) : null}
      {props.children}
      <View style={styles.divider} />
      <ActionListSection style={styles.actions} actions={props.actions} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.space.s12,
    paddingHorizontal: theme.space.s16,
    paddingTop: theme.space.s12,
    paddingBottom: theme.space.s4,
  },
  subheader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.space.s12,
    paddingHorizontal: theme.space.s16,
    paddingBottom: theme.space.s6,
  },
  title: {
    // The roster's name leads its rows: the section-title step, one above the rows' meta and summary line.
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('sectionTitle'),
    color: theme.colors.text.primary,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: theme.space.s12,
    backgroundColor: theme.colors.border.default,
  },
  actions: {
    paddingTop: theme.space.s4,
    paddingBottom: theme.space.s4,
  },
}));
