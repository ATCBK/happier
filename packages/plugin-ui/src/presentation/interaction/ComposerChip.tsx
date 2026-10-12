import * as React from 'react';
import {
  Platform,
  Pressable,
  type AccessibilityRole,
  type AccessibilityState,
  type PressableProps,
  type StyleProp,
  type View,
  type ViewStyle,
} from 'react-native';

import { resolveHappierMinimumInteractiveTargetSize } from '../../environment/interactiveTarget.js';

const nativeTargetStyle = (): ViewStyle | undefined => {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return undefined;
  const size = resolveHappierMinimumInteractiveTargetSize(Platform.OS);
  return { minWidth: size, minHeight: size };
};

type WebToggleProps = Readonly<{ 'aria-pressed'?: boolean }>;
const ComposerChipPressable = Pressable as React.ComponentType<
  React.ComponentPropsWithRef<typeof Pressable> & WebToggleProps
>;

export type HappierComposerChipProps = Readonly<{
  children?: React.ReactNode;
  onPress: NonNullable<PressableProps['onPress']>;
  disabled?: boolean;
  selected?: boolean;
  expressesSelection?: boolean;
  testID?: string;
  accessibilityRole?: AccessibilityRole;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityState?: AccessibilityState;
  hitSlop?: PressableProps['hitSlop'];
  style?: (pressed: boolean) => StyleProp<ViewStyle>;
}>;

/**
 * The one compact Composer-rail chip shell used by Happier core and Plugin UI.
 * Callers supply semantic content and the rail's theme chrome; this owner keeps
 * press, disabled/selected semantics, and native touch geometry identical.
 */
export const HappierComposerChip = React.forwardRef<View, HappierComposerChipProps>(
  function HappierComposerChip(props, ref) {
    const disabled = props.disabled === true || props.accessibilityState?.disabled === true;
    const accessibilityState = {
      ...props.accessibilityState,
      ...(disabled ? { disabled: true } : {}),
      ...(props.expressesSelection ? { selected: props.selected === true } : {}),
    } satisfies AccessibilityState;

    return (
      <ComposerChipPressable
        ref={ref}
        testID={props.testID}
        accessibilityRole={props.accessibilityRole ?? 'button'}
        accessibilityLabel={props.accessibilityLabel}
        accessibilityHint={props.accessibilityHint}
        accessibilityState={accessibilityState}
        {...(props.expressesSelection ? { 'aria-pressed': props.selected === true } : {})}
        disabled={disabled}
        hitSlop={props.hitSlop}
        onPress={props.onPress}
        style={({ pressed }) => [props.style?.(pressed), nativeTargetStyle()]}
      >
        {props.children}
      </ComposerChipPressable>
    );
  },
);
