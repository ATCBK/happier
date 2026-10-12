import type { ComponentType, ReactNode } from 'react';
import { View } from 'react-native';

import { resolveHappierInteractiveTargetFloor, useHappierNativeMinimumInteractiveTargetSize } from '../../environment/interactiveTarget.js';
import type { HappierPortableStyle } from '../portableTypes.js';
import { happierFocusRingStyle } from './focusVisible.js';
import { HappierPressable } from './Pressable.js';
import { HAPPIER_PRESS_FEEDBACK_V1 } from './pressFeedback.js';

export type HappierTextLinkButtonProps = Readonly<{
  label: string;
  onPress: () => unknown;
  accessibilityLabel?: string;
  expanded?: boolean;
  disabled?: boolean;
  testID?: string;
  Text: ComponentType<Readonly<{
    children: ReactNode;
    style: HappierPortableStyle;
    numberOfLines?: number;
    testID?: string;
  }>>;
  labelStyle: HappierPortableStyle & Readonly<{ lineHeight: number }>;
  hoverColor: string;
  focusColor: string;
  /** A sentence that wraps naturally, with the action following its final separator. */
  note?: Readonly<{ text: string; style: HappierPortableStyle }>;
  /** The host's pointer-aware touch floor; native providers retain their own physical minimum. */
  minimumTargetSize?: number;
}>;

/** One inline operation owner for host links and Find notes, with host-bound text and theme. */
export function HappierTextLinkButton(props: HappierTextLinkButtonProps): ReactNode {
  const nativeFloor = useHappierNativeMinimumInteractiveTargetSize();
  const targetFloor = resolveHappierInteractiveTargetFloor(props.minimumTargetSize, nativeFloor);
  const grow = targetFloor === undefined ? 0 : Math.max(0, (targetFloor - props.labelStyle.lineHeight) / 2);
  const action = (
    <HappierPressable
      testID={props.testID}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      expanded={props.expanded}
      disabled={props.disabled}
      onPress={props.onPress}
      style={(state) => ({
        alignSelf: 'flex-start',
        // RNW drops hitSlop. The physical frame grows vertically and gives that space back to
        // the sentence, without reaching sideways over neighbouring words.
        paddingTop: grow,
        paddingBottom: grow,
        marginTop: -grow,
        marginBottom: -grow,
        minWidth: targetFloor,
        opacity: state.disabled ? 0.4 : state.pressed ? HAPPIER_PRESS_FEEDBACK_V1.opacity : 1,
      })}
    >
      {(state) => (
        <View style={{ borderRadius: 4, ...happierFocusRingStyle({ visible: state.focused, color: props.focusColor }) }}>
          <props.Text numberOfLines={1} style={{
            ...props.labelStyle,
            ...(state.hovered ? { color: props.hoverColor, textDecorationLine: 'underline' as const } : null),
          }}>
            {props.label}
          </props.Text>
        </View>
      )}
    </HappierPressable>
  );
  return props.note ? <props.Text style={props.note.style}>{`${props.note.text} · `}{action}</props.Text> : action;
}
