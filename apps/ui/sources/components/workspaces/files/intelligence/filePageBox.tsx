import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

/**
 * The box of the File page region a floating card is mounted in, for `Popover.horizontalBoundaryRef`:
 * cards at a name slide back inside the File page instead of running over the columns beside it, and
 * keep a gutter from the page's edges so a wide card never sits flush against the column beside it.
 * Render `box` beside the Popover, inside that region.
 */
export function useFilePageBox(): Readonly<{ ref: React.RefObject<View | null>; box: React.ReactElement }> {
  const ref = React.useRef<View>(null);
  const box = <View ref={ref} style={styles.box} />;
  return { ref, box };
}

const styles = StyleSheet.create((theme) => ({
  box: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: theme.space.s8,
    right: theme.space.s8,
    pointerEvents: 'none',
  },
}));
