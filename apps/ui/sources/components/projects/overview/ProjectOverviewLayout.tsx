import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ItemList } from '@/components/ui/lists/ItemList';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';

/**
 * The Overview's side area keeps one reading width (lab `p-overview`: 272 beside the main area, 40
 * apart); the main area takes the rest. Both are steps the page column already holds at its wide
 * width (944), so on a wide pane the two areas sit side by side with the main area's readable minimum.
 */
const ASIDE_WIDTH_PX = 272;
export const PROJECT_OVERVIEW_AREA_GAP_PX = 40;
const AREA_GAP_PX = PROJECT_OVERVIEW_AREA_GAP_PX;
/** The narrowest main area that still reads as a column of widgets (a Code table, a chart). */
const MAIN_MIN_WIDTH_PX = 480;

export type ProjectOverviewArrangement = 'columns' | 'pairs' | 'stacked';

/** Below the two areas side by side, the side area still holds two of its own columns (lab `p-overview` FIT). */
const ASIDE_PAIRS_MIN_WIDTH_PX = ASIDE_WIDTH_PX * 2 + AREA_GAP_PX;

/** Side by side while the measured page holds both areas; otherwise the side area comes first (D32 FIT). */
export function resolveProjectOverviewArrangement(
  width: number | null,
): ProjectOverviewArrangement {
  if (width === null) return 'columns';
  if (width >= MAIN_MIN_WIDTH_PX + AREA_GAP_PX + ASIDE_WIDTH_PX) return 'columns';
  // Stacked, the side area's short widgets would stretch thin across the page: they pair up instead.
  return width >= ASIDE_PAIRS_MIN_WIDTH_PX ? 'pairs' : 'stacked';
}

/**
 * One dashboard document's composition (12s3): the bar and the quiet identity line, then the two areas
 * of the SAME document — main beside aside on a wide page, aside first when they no longer fit, and on a
 * phone one merged reading order supplied by the host. It owns placement only, never layout state.
 */
export const ProjectOverviewLayout = React.memo(function ProjectOverviewLayout(
  props: Readonly<{
    bar: React.ReactNode;
    identity?: React.ReactNode;
    /** A state that replaces both areas (layout unreadable, attached dashboard unavailable). */
    blocking?: React.ReactNode;
    main: React.ReactNode;
    aside: React.ReactNode;
    /** Phones: the deterministic merged order of both areas, with each area's Add after it. */
    phone?: React.ReactNode;
    onArrangementChange?: (arrangement: ProjectOverviewArrangement) => void;
    testID?: string;
  }>,
) {
  const [width, setWidth] = React.useState<number | null>(null);
  const arrangement = resolveProjectOverviewArrangement(width);
  const { onArrangementChange } = props;
  React.useEffect(() => {
    onArrangementChange?.(arrangement);
  }, [arrangement, onArrangementChange]);
  const onLayout = React.useCallback((event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.width;
    setWidth((current) => (current === next ? current : next));
  }, []);
  const testID = props.testID ?? 'project-overview';
  return (
    // The Overview is a dashboard page: the wide page column (944), one scroll owner, the page insets.
    <ItemList pageColumn="wide" testID={`${testID}.page`}>
      <PageContentColumn style={styles.wideColumn}>
        <View testID={testID} onLayout={onLayout} style={styles.page}>
          <View style={styles.head}>
            {props.bar}
            {props.identity ?? null}
          </View>
          {props.blocking ??
            (props.phone ? (
              <View testID={`${testID}.phone`} style={styles.stack}>
                {props.phone}
              </View>
            ) : (
              <View style={arrangement === 'columns' ? styles.columns : styles.stack}>
                {(arrangement === 'columns' ? ['main', 'aside'] as const : ['aside', 'main'] as const).map(area => (
                  <View key={area} testID={`${testID}.${area}`}
                    style={arrangement === 'columns' ? area === 'main' ? styles.main : styles.aside : undefined}>
                    {props[area]}
                  </View>
                ))}
              </View>
            ))}
        </View>
      </PageContentColumn>
    </ItemList>
  );
});

const styles = StyleSheet.create(() => ({
  // The page column, on the same edges as every page header and section, with the sheets' inset.
  wideColumn: {
    paddingHorizontal: PAGE_LIST_METRICS.sheetInsetPx,
    paddingTop: PAGE_LIST_METRICS.sectionGapPx,
  },
  page: { gap: 24, minWidth: 0 },
  head: { gap: 12 },
  columns: { flexDirection: 'row', alignItems: 'flex-start', gap: AREA_GAP_PX },
  main: { flex: 1, minWidth: 0 },
  aside: { width: ASIDE_WIDTH_PX, flexShrink: 0 },
  stack: { gap: 24 },
}));
