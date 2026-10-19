import * as React from 'react';
import {
  Platform,
  Pressable,
  type AccessibilityState,
  type ViewStyle,
} from 'react-native';

import { resolveHappierMinimumInteractiveTargetSize } from '../../environment/interactiveTarget.js';
import type {
  HappierAccessibilityRole,
  HappierAccessibilityState,
  HappierGestureResponderEvent,
  HappierStyleProp,
} from '../portableTypes.js';
import type { HappierPressableProps } from './Pressable.js';

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
  onPress: (event: HappierGestureResponderEvent) => void;
  disabled?: boolean;
  selected?: boolean;
  expressesSelection?: boolean;
  testID?: string;
  accessibilityRole?: HappierAccessibilityRole;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityState?: HappierAccessibilityState;
  hitSlop?: HappierPressableProps['hitSlop'];
  style?: (pressed: boolean) => HappierStyleProp;
}>;

/**
 * The one compact Composer-rail chip shell used by Happier core and Plugin UI.
 * Callers supply semantic content and the rail's theme chrome; this owner keeps
 * press, disabled/selected semantics, and native touch geometry identical.
 */
export const HappierComposerChip = React.forwardRef<unknown, HappierComposerChipProps>(
  function HappierComposerChip(props, ref) {
    const disabled = props.disabled === true || props.accessibilityState?.disabled === true;
    const accessibilityState = {
      ...props.accessibilityState,
      ...(disabled ? { disabled: true } : {}),
      ...(props.expressesSelection ? { selected: props.selected === true } : {}),
    } satisfies AccessibilityState;

    return (
      <ComposerChipPressable
        // The native renderer owns the instance; the public ref is deliberately opaque.
        ref={ref as React.ComponentProps<typeof ComposerChipPressable>['ref']}
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
