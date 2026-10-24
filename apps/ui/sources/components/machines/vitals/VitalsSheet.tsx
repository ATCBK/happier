import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { readHappierVisibleLayoutWidth } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_DATA_METRICS, HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useDeviceType } from '@/utils/platform/responsive';

/** A tile reads at about a phone's width; below two of them side by side the sheet stacks them. */
const TWO_COLUMN_MIN_WIDTH_PX = 560;

/**
 * The four vitals in one sheet with ink dividers (lab `rv` O): two by two where there is room, one tile
 * per row on a phone or in a narrow pane. Tiles in a row share the row's height, so their charts start
 * on one line; nothing about the sheet's shape depends on its values.
 */
export const VitalsSheet = React.memo(function VitalsSheet(
  props: Readonly<{
    children: readonly React.ReactNode[];
    testID?: string;
    /** Tiles side by side where there is room (the Processes tab's three vitals sit in one row, lab `rp` H). */
    columns?: 2 | 3;
  }>,
) {
  const phone = useDeviceType() === 'phone';
  const [narrow, setNarrow] = React.useState(false);
  const onLayout = React.useCallback((event: LayoutChangeEvent) => {
    const width = readHappierVisibleLayoutWidth(event.nativeEvent.layout.width);
    if (width !== null) setNarrow(width < TWO_COLUMN_MIN_WIDTH_PX);
  }, []);
  const columns = phone || narrow ? 1 : (props.columns ?? 2);
  const stacked = columns === 1;
  const tiles = React.Children.toArray(props.children);
  const rows: React.ReactNode[][] = [];
  for (let index = 0; index < tiles.length; index += columns)
    rows.push(tiles.slice(index, index + columns));
  return (
    <ItemGroup header="none">
      <VitalsSheetStackedContext.Provider value={stacked}>
      <View testID={props.testID} onLayout={phone ? undefined : onLayout}>
        {rows.map((row, rowIndex) => (
          <View
            key={rowIndex}
            style={[styles.row, rowIndex > 0 ? styles.rowDivider : null]}
          >
            {row.map((tile, columnIndex) => (
              <View
                key={columnIndex}
                style={[
                  styles.cell,
                  columnIndex > 0 ? styles.cellDivider : null,
                ]}
              >
                {tile}
              </View>
            ))}
          </View>
        ))}
      </View>
      </VitalsSheetStackedContext.Provider>
    </ItemGroup>
  );
});

/**
 * Whether the sheet stacks its tiles one per row (a phone or a narrow pane). A stacked tile with no
 * instruments reads as a row, its figure at the right (lab `rg` G7p, `rv` Op "More from"), so a summary of
 * a few figures does not take a screen.
 */
const VitalsSheetStackedContext = React.createContext(false);
/** A figure drawn as a row's value rather than a tile's headline. */
const VitalsValueInRowContext = React.createContext(false);

/**
 * A tile shown somewhere else (a Metric widget) opens its machine page from its title. The tile's own
 * chart and disclosures stay separate controls, never nested inside one big button.
 */
export const VitalsTileOpenContext = React.createContext<Readonly<{ onOpen: () => void; accessibilityLabel: string }> | null>(null);

/**
 * One vital's anatomy (lab kit `vital`): the label with its quiet fact at the right, the value with its
 * unit and a short phrase, one line under it, then the tile's instruments. Every tile keeps this rhythm,
 * so their values and charts line up across the sheet.
 */
export const VitalsTile = React.memo(function VitalsTile(
  props: Readonly<{
    label: string;
    labelAccessory?: React.ReactNode;
    meta?: React.ReactNode;
    value: React.ReactNode;
    sub?: React.ReactNode;
    children?: React.ReactNode;
    testID?: string;
  }>,
) {
  const open = React.useContext(VitalsTileOpenContext);
  const stacked = React.useContext(VitalsSheetStackedContext);
  if (stacked && !props.children && !open && (props.meta === undefined || props.meta === null)) {
    return (
      <View testID={props.testID} style={[styles.tile, styles.rowTile]}>
        <View style={styles.rowText}>
          <View style={styles.labelRow}>
            <Text accessibilityRole="header" numberOfLines={1} style={styles.rowLabel}>
              {props.label}
            </Text>
            {props.labelAccessory}
          </View>
          {props.sub ? <View style={styles.sub}>{props.sub}</View> : null}
        </View>
        <View style={styles.rowValue}>
          <VitalsValueInRowContext.Provider value>{props.value}</VitalsValueInRowContext.Provider>
        </View>
      </View>
    );
  }
  return (
    <View testID={props.testID} style={styles.tile}>
      <View style={styles.labelRow}>
        {open ? (
          <HappierPressable
            testID={props.testID ? `${props.testID}.open` : undefined}
            accessibilityRole="button"
            accessibilityLabel={open.accessibilityLabel}
            onPress={open.onOpen}
          >
            {(state) => (
              <Text numberOfLines={1} style={[styles.label, state.hovered ? styles.labelHovered : null]}>
                {props.label}
              </Text>
            )}
          </HappierPressable>
        ) : (
          <Text accessibilityRole="header" numberOfLines={1} style={styles.label}>
            {props.label}
          </Text>
        )}
        {props.labelAccessory}
        {props.meta !== undefined && props.meta !== null ? (
          <View style={styles.meta}>{props.meta}</View>
        ) : null}
      </View>
      <View style={styles.valueRow}>{props.value}</View>
      {props.sub ? <View style={styles.sub}>{props.sub}</View> : null}
      {props.children ? (
        <View style={styles.body}>{props.children}</View>
      ) : null}
    </View>
  );
});

/** The tile's value: the number, its unit and the phrase after it ("71 GB free", "12 %"). */
export function VitalsValue(
  props: Readonly<{
    value: string;
    unit?: string;
    phrase?: string;
    color?: string;
    leading?: React.ReactNode;
  }>,
) {
  const inRow = React.useContext(VitalsValueInRowContext);
  return (
    <>
      {props.leading}
      <Text
        numberOfLines={1}
        style={[inRow ? styles.rowValueText : styles.value, props.color ? { color: props.color } : null]}
      >
        {props.value}
      </Text>
      {props.unit ? (
        <Text numberOfLines={1} style={styles.unit}>
          {props.unit}
        </Text>
      ) : null}
      {props.phrase ? (
        <Text numberOfLines={1} style={styles.phrase}>
          {props.phrase}
        </Text>
      ) : null}
    </>
  );
}

/** The one line under a value; `strong` runs read in ink ("**180 MB** free · 3.8 GB in use"). */
export function VitalsSubLine(
  props: Readonly<{ children: React.ReactNode; testID?: string }>,
) {
  return (
    <Text testID={props.testID} numberOfLines={1} style={styles.subText}>
      {props.children}
    </Text>
  );
}

export function VitalsStrong(
  props: Readonly<{ children: React.ReactNode; color?: string }>,
) {
  return (
    <Text style={[styles.strong, props.color ? { color: props.color } : null]}>
      {props.children}
    </Text>
  );
}

/** A quiet fact at a tile's top right ("load 2.31", "128 GB", "2 volumes"). */
export function VitalsMeta(
  props: Readonly<{ children: React.ReactNode; leading?: React.ReactNode }>,
) {
  return (
    <View style={styles.metaRow}>
      {props.leading}
      <Text numberOfLines={1} style={styles.metaText}>
        {props.children}
      </Text>
    </View>
  );
}

export const vitalsSheetStyles = StyleSheet.create((theme) => ({
  caption: {
    ...Typography.variant('meta'),
    ...Typography.tabular(),
    color: theme.colors.text.tertiary,
  },
}));

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  rowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
  },
  cell: {
    flex: 1,
    minWidth: 0,
  },
  cellDivider: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: theme.colors.border.subtle,
  },
  tile: {
    paddingHorizontal: PAGE_LIST_METRICS.rowPaddingHorizontalPx,
    paddingTop: PAGE_LIST_METRICS.rowPaddingVerticalPx + 4,
    paddingBottom: PAGE_LIST_METRICS.rowPaddingVerticalPx + 4,
    minWidth: 0,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    minHeight: 18,
  },
  label: {
    ...Typography.variant('meta'),
    ...Typography.default('medium'),
    color: theme.colors.text.secondary,
    flexShrink: 0,
  },
  // Hover changes colour only: the title it opens from reads as ink.
  labelHovered: {
    color: theme.colors.text.primary,
  },
  meta: {
    marginLeft: 'auto',
    minWidth: 0,
    flexShrink: 1,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
    minWidth: 0,
  },
  metaText: {
    ...Typography.variant('meta'),
    ...Typography.tabular(),
    color: theme.colors.text.tertiary,
    flexShrink: 1,
  },
  valueRow: {
    marginTop: theme.space.s6,
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: theme.space.s4,
    minHeight: HAPPIER_DATA_METRICS.statValue.lineHeight,
    minWidth: 0,
  },
  value: {
    ...Typography.default('semiBold'),
    ...Typography.tabular(),
    fontSize: HAPPIER_DATA_METRICS.statValue.fontSize,
    lineHeight: HAPPIER_DATA_METRICS.statValue.lineHeight,
    letterSpacing: HAPPIER_DATA_METRICS.statValue.letterSpacing,
    color: theme.colors.text.primary,
  },
  unit: {
    ...Typography.variant('meta'),
    ...Typography.default('medium'),
    color: theme.colors.text.secondary,
  },
  phrase: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
    marginLeft: theme.space.s6,
    flexShrink: 1,
  },
  sub: {
    marginTop: theme.space.s2,
    minWidth: 0,
  },
  subText: {
    ...Typography.variant('meta'),
    ...Typography.tabular(),
    color: theme.colors.text.secondary,
  },
  strong: {
    ...Typography.default('medium'),
    color: theme.colors.text.primary,
  },
  rowTile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
  },
  rowText: {
    flex: 1,
    minWidth: 0,
  },
  rowLabel: {
    ...Typography.variant('label'),
    color: theme.colors.text.primary,
    flexShrink: 1,
  },
  rowValue: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: theme.space.s4,
    flexShrink: 0,
  },
  rowValueText: {
    ...Typography.variant('label'),
    ...Typography.tabular(),
    color: theme.colors.text.primary,
  },
  body: {
    marginTop: HAPPIER_DATA_METRICS.blockGapPx,
    gap: HAPPIER_DATA_METRICS.rowGapPx,
    minWidth: 0,
  },
}));

/**
 * A whole translated sentence with one figure in it read in ink ("**180 MB** free · 3.8 GB in use"): the
 * figure is found in the sentence the locale built, so word order stays the locale's.
 */
export function VitalsEmphasis(props: Readonly<{ text: string; emphasis: string }>) {
  const at = props.text.indexOf(props.emphasis);
  if (!props.emphasis || at < 0) return <>{props.text}</>;
  return (
    <>
      {props.text.slice(0, at)}
      <VitalsStrong>{props.emphasis}</VitalsStrong>
      {props.text.slice(at + props.emphasis.length)}
    </>
  );
}

