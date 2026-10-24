import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { Tooltip } from '@/components/ui/overlays/Tooltip';

/**
 * A configuration collection's row states (lab `sfcols`, P8): what a row needs said about the thing it names.
 * The domain decides which applies (an account's health, a server's sign-in, a skill's update); this only draws.
 */
export type CollectionRowStatus =
  /** It cannot work until the person signs in again. */
  | 'signIn'
  /** The service revoked access (only when the service reported that cause). */
  | 'revoked'
  /** It failed to load or run. */
  | 'failed'
  /** It waits for the person to look at it (a review, a limit close by). */
  | 'review'
  /** Turned off or retired: still there, not in use. */
  | 'off'
  /** Where it runs is offline. */
  | 'offline'
  /** A newer version is available. */
  | 'update'
  /** The facts shown are old. */
  | 'stale';

type Tone = 'warning' | 'danger' | 'neutral';

const STATUS_DRAWING: Readonly<
  Record<CollectionRowStatus, Readonly<{ icon: IconName; tone: Tone }>>
> = Object.freeze({
  signIn: { icon: 'key', tone: 'warning' },
  revoked: { icon: 'warning-circle', tone: 'danger' },
  failed: { icon: 'warning-circle', tone: 'danger' },
  review: { icon: 'warning', tone: 'warning' },
  off: { icon: 'minus-circle', tone: 'neutral' },
  offline: { icon: 'cloud-slash', tone: 'neutral' },
  update: { icon: 'arrow-up', tone: 'neutral' },
  stale: { icon: 'clock', tone: 'neutral' },
});

/** The status slot's glyph column (lab `clstatus`/`sfcols`): the same 14 px slot the work rows reserve. */
const STATUS_SLOT_PX = 14;

const styles = StyleSheet.create(() => ({
  slot: {
    width: STATUS_SLOT_PX,
    height: STATUS_SLOT_PX,
    alignItems: 'center',
    justifyContent: 'center',
  },
}));

/**
 * The row's status slot, icon only (P8: icon-only status replaces "Needs sign-in" pills): amber when the person
 * is needed, rose when it failed, neutral ink otherwise. The word lives in the tooltip and the accessible name;
 * healthy rows draw nothing.
 */
export const CollectionStatusGlyph = React.memo(function CollectionStatusGlyph(
  props: Readonly<{
    status: CollectionRowStatus;
    /** The state in words: the tooltip and the accessible name. */
    label: string;
    testID?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const drawing = STATUS_DRAWING[props.status];
  const color =
    drawing.tone === 'warning'
      ? theme.colors.state.warning.foreground
      : drawing.tone === 'danger'
        ? theme.colors.state.danger.foreground
        : theme.colors.text.secondary;
  return (
    <Tooltip label={props.label}>
      <View
        testID={props.testID}
        accessible
        accessibilityRole="image"
        accessibilityLabel={props.label}
        style={styles.slot}
      >
        <Icon name={drawing.icon} size={STATUS_SLOT_PX} color={color} />
      </View>
    </Tooltip>
  );
});
