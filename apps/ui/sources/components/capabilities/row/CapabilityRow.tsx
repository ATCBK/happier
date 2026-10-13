import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { isHappierPageRowNarrow } from '@happier-dev/plugin-ui/presentation';

import {
  CapabilityFacts,
  type CapabilityFactsProps,
} from '@/components/capabilities/facts/CapabilityFacts';
import { CapabilityStatusChip } from '@/components/capabilities/status/CapabilityStatusChip';
import {
  presentCapabilityStatus,
  type CapabilityStatus,
} from '@/components/capabilities/status/capabilityStatusPresentation';
import { Item } from '@/components/ui/lists/Item';
import { collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { Text } from '@/components/ui/text/Text';

export type CapabilityRowProps = Readonly<{
  title: string;
  description?: string | null;
  /** The where-summary from `shortWhereItsOn` (or a session scope word); never truncated (R1). */
  whereSummary?: React.ReactNode;
  facts?: CapabilityFactsProps;
  /** When present and not silent, replaces the facts line (status takes the facts line). */
  status?: CapabilityStatus | null;
  /** Identity mark (MCP server mark, agent mark). Skills have none. */
  mark?: React.ReactNode;
  /** Right action column (Add, Install, "In your library ✓"; on scope pages only, a `Switch`). */
  action?: React.ReactNode;
  selected?: boolean;
  dimmed?: boolean;
  density?: 'page' | 'rail' | 'menu';
  onPress?: () => void;
  /** Pointer over or keyboard focus on the row (a homepage map previews its reach); false when it leaves. */
  onPreviewChange?: (active: boolean) => void;
  testID: string;
}>;

/**
 * One capability row for every capability list (rails, homepages, Found, machine page, composer): the name never
 * squeezed, the where-summary at the title line's end and never truncated, the description truncating first, and
 * the facts line, which a non-silent status takes. Menu density draws the scope as its own fixed column before the
 * action instead of on the title line.
 */
export const CapabilityRow = React.memo(function CapabilityRow(
  props: CapabilityRowProps,
) {
  const density = props.density ?? 'page';
  // Menu density recomposes on a narrow row (a phone sheet): the scope leaves its column for line 3.
  const [narrow, setNarrow] = React.useState(false);
  const onLayout = React.useCallback((event: LayoutChangeEvent) => {
    setNarrow(isHappierPageRowNarrow(event.nativeEvent.layout.width));
  }, []);
  const status =
    props.status != null &&
    presentCapabilityStatus(props.status, 'row').pill !== null
      ? props.status
      : null;
  const summary =
    props.whereSummary == null ? null : typeof props.whereSummary ===
      'string' ? (
      <Text variant="meta" numberOfLines={1} style={styles.summary}>
        {props.whereSummary}
      </Text>
    ) : (
      props.whereSummary
    );
  const factsLine =
    status !== null ? (
      <CapabilityStatusChip status={status} testID={`${props.testID}:status`} />
    ) : props.facts === undefined ? null : (
      <CapabilityFacts {...props.facts} />
    );
  const menu = density === 'menu';
  // A dimmed row (off for this session) fades what it is, never its action: "Turn on" stays at full ink.
  const dimmed = props.dimmed === true;
  const menuNarrow = menu && narrow;
  // Menu density has one line 2 under the name, at the subtitle's own rhythm: a speaking status, else the
  // description (a session change), else the facts. On a narrow row the scope follows it as line 3.
  const menuLine2: React.ReactNode =
    status !== null || props.description == null ? factsLine : props.description;
  const menuSubtitle: React.ReactNode =
    menuNarrow && summary !== null ? (
      <View style={[styles.narrowLines, dimmed ? styles.dimmed : null]}>
        {typeof menuLine2 === 'string' ? (
          <Text variant="meta" numberOfLines={1} style={styles.summary}>{menuLine2}</Text>
        ) : menuLine2}
        <View testID={`${props.testID}:scope`}>{summary}</View>
      </View>
    ) : (
      menuLine2
    );
  const bottom = menu ? null : factsLine;
  const right = menuNarrow ? (
    (props.action ?? null)
  ) : menu ? (
    summary === null && props.action == null ? null : (
      <View style={styles.menuColumns}>
        {summary === null ? null : (
          <View style={[styles.scope, dimmed ? styles.dimmed : null]} testID={`${props.testID}:scope`}>
            {summary}
          </View>
        )}
        {props.action == null ? null : (
          <View style={styles.menuAction}>{props.action}</View>
        )}
      </View>
    )
  ) : (
    (props.action ?? null)
  );
  return (
    <View {...(menu ? { onLayout } : {})}>
      <Item
        title={props.title}
        {...(menu
          ? menuSubtitle == null ? {} : { subtitle: menuSubtitle }
          : props.description == null ? {} : { subtitle: props.description })}
        subtitleLines={1}
        {...(menu || summary === null ? {} : { titleMeta: summary })}
        {...(props.mark == null ? {} : { icon: dimmed ? <View style={styles.dimmed}>{props.mark}</View> : props.mark })}
        {...(dimmed ? { titleStyle: styles.dimmed, subtitleStyle: styles.dimmed } : {})}
        {...(right === null ? {} : { rightElement: right })}
        {...(bottom === null
          ? {}
          : {
              bottomElement: <View style={styles.facts}>{bottom}</View>,
              bottomElementInset: 'text' as const,
            })}
        {...(props.selected === undefined ? {} : { selected: props.selected })}
        {...(density === 'rail'
          ? { density: 'compact' as const, pressableStyle: collectionListStyles.row }
          : {})}
        {...(props.onPreviewChange === undefined
          ? {}
          : {
              onHoverIn: () => props.onPreviewChange?.(true),
              onHoverOut: () => props.onPreviewChange?.(false),
              onFocus: () => props.onPreviewChange?.(true),
              onBlur: () => props.onPreviewChange?.(false),
            })}
        {...(menu ? { rowRole: 'menu' as const } : {})}
        {...(props.onPress === undefined ? {} : { onPress: props.onPress })}
        showChevron={false}
        testID={props.testID}
      />
    </View>
  );
});

/** Menu-density columns: the scope words ("In client-site", "Everywhere") and the action (fix + x, or Turn on). */
const MENU_SCOPE_COLUMN_PX = 112;
const MENU_ACTION_COLUMN_PX = 120;

const styles = StyleSheet.create((theme) => ({
  summary: {
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  facts: { paddingTop: theme.space.s2, minWidth: 0 },
  menuColumns: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
  },
  // Menu density is one grid for every row of a menu (IR-81): the scope starts at the same x on each
  // row and the action column keeps one width, so a row with a fix and a row with × align. Both are
  // minimums: a longer scope or a longer translated fix grows its row instead of truncating.
  scope: { flexShrink: 0, minWidth: MENU_SCOPE_COLUMN_PX, alignItems: 'flex-start' },
  menuAction: {
    minWidth: MENU_ACTION_COLUMN_PX,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: theme.space.s8,
  },
  narrowLines: { gap: theme.space.s2, alignItems: 'flex-start' },
  dimmed: { opacity: 0.6 },
}));
