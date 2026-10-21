import * as React from 'react';
import { StyleSheet, View } from 'react-native';

/**
 * The box of the File page region a floating card is mounted in, for `Popover.horizontalBoundaryRef`:
 * cards at a name slide back inside the File page instead of running over the columns beside it.
 * Render `box` beside the Popover, inside that region.
 */
export function useFilePageBox(): Readonly<{ ref: React.RefObject<View | null>; box: React.ReactElement }> {
  const ref = React.useRef<View>(null);
  const box = <View ref={ref} style={styles.box} />;
  return { ref, box };
}

const styles = StyleSheet.create({
  box: {
    ...StyleSheet.absoluteFillObject,
    pointerEvents: 'none',
  },
});
