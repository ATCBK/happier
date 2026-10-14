import * as React from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
  HappierDiffStat,
  type HappierDiffStatKind,
  type HappierDiffStatTextProps,
} from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/** Core's text owner (the user's font scale) in the row-meta step and the version-control inks. */
function DiffStatText(props: HappierDiffStatTextProps) {
  return (
    <Text
      style={props.kind ? [styles.stat, styles[props.kind]] : styles.stat}
      {...(props.numberOfLines === undefined
        ? {}
        : { numberOfLines: props.numberOfLines })}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
    >
      {props.children}
    </Text>
  );
}

/**
 * Happier core's binding of the shared diff stat (`@happier-dev/plugin-ui/presentation`, the same owner
 * plugin surfaces draw with): it supplies only core's text owner and inks.
 */
export const DiffStat = React.memo(function DiffStat(
  props: Readonly<{
    testID?: string;
    added: number;
    removed: number;
    renderCount?: (
      kind: HappierDiffStatKind,
      text: string,
      style: StyleProp<TextStyle>,
    ) => React.ReactNode;
  }>,
) {
  const { renderCount } = props;
  return (
    <HappierDiffStat
      Text={DiffStatText}
      added={props.added}
      removed={props.removed}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
      {...(renderCount
        ? {
            renderCount: (kind: HappierDiffStatKind, text: string) =>
              renderCount(kind, text, [styles.stat, styles[kind]]),
          }
        : {})}
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  stat: {
    ...Typography.variant('meta'),
    ...Typography.tabular(),
    flexShrink: 0,
  },
  added: {
    color: theme.colors.versionControl.added.foreground,
  },
  removed: {
    color: theme.colors.versionControl.removed.foreground,
  },
}));
