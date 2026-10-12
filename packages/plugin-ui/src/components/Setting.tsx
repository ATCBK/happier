import type { ReactElement, ReactNode } from 'react';

import {
  HappierSettingStatusLine,
  HappierSettingValueSlot,
  type HappierSettingRowLayout,
} from '../presentation/form/SettingField.js';
import { Item } from './List.js';
import { usePluginTranslation } from './PluginUiProvider.js';
import { resolveAuthorText } from './resolveAuthorText.js';

export type SettingRowLayout = HappierSettingRowLayout;

export type SettingRowProps = Readonly<{
  title?: string;
  /** A key from this plugin's declared translation bundle; `title` is its fallback. */
  titleKey?: string;
  /** What the setting does, or its current state, under the label. */
  hint?: string;
  hintKey?: string;
  /**
   * `inline` (default) keeps a switch or a short value at the row's end; `adaptive` moves a segmented
   * control or a field beneath the label when the row is too narrow for both; `stacked` always places a
   * wide control (a long field with its actions) beneath.
   */
  layout?: SettingRowLayout;
  /** The one control; omit it for a setting that can only be read. */
  control?: ReactNode;
  /** The value in words, for a setting that can only be read. */
  value?: string;
  /** A whole-row press that changes the value (a switch row); the control stays its own target. */
  onPress?: () => unknown;
  disabled?: boolean;
  testID?: string;
}>;

/**
 * One setting on a custom settings page: the label, the hint under it and the control in the row's one
 * slot — the same row Happier draws for its declared plugin settings and its own registries. Drafts,
 * validation and writes stay with the author's page; this is presentation only.
 */
export function SettingRow(props: SettingRowProps): ReactElement {
  const translate = usePluginTranslation();
  const layout = props.layout ?? 'inline';
  return (
    <Item
      testID={props.testID}
      title={resolveAuthorText(translate, props.title, props.titleKey)}
      subtitle={resolveAuthorText(translate, props.hint, props.hintKey)}
      detail={props.value}
      accessory={props.control}
      accessoryOutsidePressable={props.control !== undefined && props.onPress !== undefined ? true : undefined}
      accessoryWraps={layout === 'adaptive' ? true : undefined}
      accessoryBelow={layout === 'stacked' ? true : undefined}
      onPress={props.onPress}
      disabled={props.disabled}
    />
  );
}

export type SettingValueSlotProps = Readonly<{
  kind: 'number' | 'text';
  /** The unit a number is typed in ("ms", "MB"). */
  unit?: string;
  children: ReactNode;
}>;

/** The slot of a typed value: a number is a compact box with its unit; text takes the width left. */
export function SettingValueSlot(props: SettingValueSlotProps): ReactElement {
  return <HappierSettingValueSlot kind={props.kind} unit={props.unit}>{props.children}</HappierSettingValueSlot>;
}

export type SettingStatusLineProps = Readonly<{
  /** `danger` is a refused change, announced as it appears; `secondary` (default) says what is stored. */
  tone?: 'secondary' | 'danger';
  children: string;
  testID?: string;
}>;

/** A line under a stacked control: what is stored, or why the last change was refused. */
export function SettingStatusLine(props: SettingStatusLineProps): ReactElement {
  return <HappierSettingStatusLine testID={props.testID} tone={props.tone}>{props.children}</HappierSettingStatusLine>;
}
