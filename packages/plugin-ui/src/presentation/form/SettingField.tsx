import type { ReactNode } from 'react';
import { View } from 'react-native';

import { HappierText } from '../text/Text.js';

/**
 * Where a setting's control sits in its row: `inline` keeps a switch or a short value at the row's end;
 * `adaptive` moves a segmented control or a field beneath the label when the row is too narrow for both;
 * `stacked` always places a wide control (a long field with its actions) beneath.
 */
export type HappierSettingRowLayout = 'inline' | 'adaptive' | 'stacked';

/** The value slot's geometry: a number is a compact box with its unit; text takes the width left. */
export const HAPPIER_SETTING_VALUE_SLOT_METRICS = Object.freeze({
  number: Object.freeze({ widthPx: 128, gapPx: 8 }),
  text: Object.freeze({ minWidthPx: 200, maxWidthPx: 360 }),
});

/** The input a setting's control fills inside its slot. */
export const HAPPIER_SETTING_INPUT_STYLE = Object.freeze({
  flexGrow: 1,
  flexShrink: 1,
  minWidth: 0,
});

export type HappierSettingValueSlotProps = Readonly<{
  kind: 'number' | 'text';
  /** The unit a number is typed in ("ms", "MB"); a host passes its own typed text node. */
  unit?: ReactNode;
  children: ReactNode;
}>;

/**
 * The slot of a typed value in a setting row: a number is a compact box with its unit beside it; free
 * text and addresses take the width the row leaves, within a readable bound.
 */
export function HappierSettingValueSlot({ kind, unit, children }: HappierSettingValueSlotProps) {
  const number = HAPPIER_SETTING_VALUE_SLOT_METRICS.number;
  const text = HAPPIER_SETTING_VALUE_SLOT_METRICS.text;
  return (
    <View style={kind === 'number'
      ? { flexDirection: 'row', alignItems: 'center', gap: number.gapPx, width: number.widthPx, justifyContent: 'flex-end' }
      : { flexDirection: 'row', flexGrow: 1, flexShrink: 1, minWidth: text.minWidthPx, maxWidth: text.maxWidthPx }}
    >
      {children}
      {kind === 'number' && unit
        ? typeof unit === 'string' ? <HappierText variant="meta" tone="secondary">{unit}</HappierText> : unit
        : null}
    </View>
  );
}

export type HappierSettingStatusLineProps = Readonly<{
  testID?: string;
  /** `danger` is a refused change, announced as it appears; `secondary` (default) says what is stored. */
  tone?: 'secondary' | 'danger';
  /** The line; a host passes its own typed text node. */
  children: ReactNode;
}>;

/** A line under a stacked control: what is stored, or why the last change was refused. */
export function HappierSettingStatusLine({ testID, tone, children }: HappierSettingStatusLineProps) {
  const refused = tone === 'danger';
  return (
    <View
      testID={testID}
      // A refusal arrives after an asynchronous commit and moves nothing else on screen.
      role={refused ? 'alert' : undefined}
      accessibilityRole={refused ? 'alert' : undefined}
      accessibilityLiveRegion={refused ? 'assertive' : undefined}
      aria-live={refused ? 'assertive' : undefined}
    >
      {typeof children === 'string'
        ? <HappierText variant="meta" tone={refused ? 'danger' : 'secondary'}>{children}</HappierText>
        : children}
    </View>
  );
}
