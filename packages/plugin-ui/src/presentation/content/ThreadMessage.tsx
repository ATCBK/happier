import type { ReactElement, ReactNode } from 'react';
import { View } from 'react-native';

import type { HappierPortableStyle, HappierStyleProp } from '../portableTypes.js';

export type HappierThreadMessageProps = Readonly<{
  testID?: string;
  startsGroup: boolean;
  selected?: boolean;
  /** Omit for an unattributed pending message; null retains the grouped face column. */
  face?: ReactNode;
  attribution?: ReactNode;
  children?: ReactNode;
  trailing?: ReactNode;
  style?: HappierStyleProp;
  space: Readonly<{ s2: number; s8: number; s10: number; s12: number; s16: number }>;
  selectionColors: Readonly<{ background: string; foreground: string }>;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}>;

/**
 * One authored-message frame, shared by Discussion rows and plugin threads.
 * The caller owns content, identity, attribution, selection and delivery state.
 */
export function HappierThreadMessage(props: HappierThreadMessageProps): ReactElement {
  const { space } = props;
  return <View testID={props.testID}
    onPointerEnter={props.onPointerEnter} onPointerLeave={props.onPointerLeave}
    style={[
      messageStyle,
      { gap: space.s10, paddingHorizontal: space.s16, paddingTop: space.s12, paddingBottom: space.s2 },
      props.style,
      !props.startsGroup ? { paddingTop: space.s2 } : null,
      props.selected ? { backgroundColor: props.selectionColors.background, borderLeftColor: props.selectionColors.foreground } : null,
    ]}>
    {props.face !== undefined ? <View style={faceStyle}>{props.startsGroup ? props.face : null}</View> : null}
    <View style={[bodyStyle, { gap: space.s2 }]}>
      {props.startsGroup && props.attribution !== undefined ? <View style={[attributionStyle, { gap: space.s8 }]}>{props.attribution}</View> : null}
      {props.children}
    </View>
    {props.trailing}
  </View>;
}

const messageStyle = {
  flexDirection: 'row', alignItems: 'flex-start', width: '100%', alignSelf: 'center',
  borderRadius: 10, borderLeftWidth: 2, borderLeftColor: 'transparent',
} satisfies HappierPortableStyle;
const faceStyle = { width: 28, alignItems: 'center' } satisfies HappierPortableStyle;
const bodyStyle = { flex: 1, minWidth: 0 } satisfies HappierPortableStyle;
const attributionStyle = { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap' } satisfies HappierPortableStyle;
