import { memo, type ComponentType, type ReactElement } from 'react';
import { View } from 'react-native';

import { HAPPIER_SPACE_STEPS } from '../../environment/spacing.js';
import {
  presentHappierCapabilityStatus,
  type HappierCapabilityStatus,
  type HappierCapabilityStatusLabels,
  type HappierCapabilityStatusPlacement,
  type HappierCapabilityStatusVariant,
} from './capabilityStatus.js';

export type HappierCapabilityStatusPillProps = Readonly<{
  variant: HappierCapabilityStatusVariant;
  chrome: 'pill' | 'plain';
  label: string;
  detail?: string;
}>;

export type HappierCapabilityStatusFixProps = Readonly<{
  title: string;
  onPress: () => void;
  testID?: string;
}>;

export type HappierCapabilityStatusChipProps = Readonly<{
  status: HappierCapabilityStatus;
  placement?: HappierCapabilityStatusPlacement;
  /** In a list's facts line the fix stays in the row's action column; the chip alone is drawn. */
  showFix?: boolean;
  testID?: string;
  labels: HappierCapabilityStatusLabels;
  /** The caller's status pill (one line, sentence-case phrase). */
  Pill: ComponentType<HappierCapabilityStatusPillProps>;
  /** The caller's small secondary button for the status's one fix. */
  Fix: ComponentType<HappierCapabilityStatusFixProps>;
  /** The caller's quiet meta text for the reason line. */
  Reason: ComponentType<Readonly<{ children: string }>>;
  /** The caller's spacing steps (a compact density tightens them). */
  space?: Readonly<Record<'s2' | 's8', number>>;
}>;

/**
 * A capability status where it speaks: the pill, its one fix beside it, and a reason (why it stopped) wrapping
 * whole under it. Silent statuses (ready, and `off` in rows) draw nothing.
 */
export const HappierCapabilityStatusChip = memo(
  function HappierCapabilityStatusChip(
    props: HappierCapabilityStatusChipProps,
  ): ReactElement | null {
    const { Pill, Fix, Reason } = props;
    const presentation = presentHappierCapabilityStatus(
      props.status,
      props.placement ?? 'row',
      props.labels,
    );
    const pill = presentation.pill;
    if (pill === null) return null;
    const fix = props.status.fix;
    const space = props.space ?? HAPPIER_SPACE_STEPS;
    return (
      <View style={[ROOT, { gap: space.s2 }]} testID={props.testID}>
        <View style={[ROW, { gap: space.s8 }]}>
          <Pill
            variant={pill.variant}
            chrome={pill.chrome}
            label={pill.label}
            {...(pill.detail === undefined ? {} : { detail: pill.detail })}
          />
          {props.showFix === true &&
          fix !== undefined &&
          presentation.fixLabel !== undefined ? (
            <Fix
              title={presentation.fixLabel}
              onPress={fix.onPress}
              {...(props.testID === undefined
                ? {}
                : { testID: `${props.testID}:fix` })}
            />
          ) : null}
        </View>
        {presentation.reason === undefined ? null : (
          <Reason>{presentation.reason}</Reason>
        )}
      </View>
    );
  },
);

// The pill says the state short; a reason (why it stopped) wraps under it, whole.
const ROOT = {
  minWidth: 0,
  flexShrink: 1,
} as const;
const ROW = {
  flexDirection: 'row',
  alignItems: 'center',
  minWidth: 0,
  flexShrink: 1,
} as const;
