import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * Where a pane's picture is from, said once in its bar: the Machine as a status dot and its name
 * (lab `computer` viewer bar, "● NLDW3"). The Computer and Browser panes both draw it, so the
 * Machine reads the same wherever the viewer is docked. `online: false` is the only disconnected
 * dot; an unknown presence is not presented as offline.
 */
export function SessionViewerMachineMark(props: Readonly<{
  name: string;
  online?: boolean | null;
  testID?: string;
}>): React.ReactElement {
  const { theme } = useUnistyles();
  return (
    <View style={stylesheet.root} testID={props.testID}>
      {typeof props.online === 'boolean' ? <StatusDot
        color={props.online === false ? theme.colors.status.disconnected : theme.colors.status.connected}
      /> : null}
      <Text style={stylesheet.name} numberOfLines={1}>{props.name}</Text>
    </View>
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  root: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    flexShrink: 2,
    minWidth: 0,
  },
  name: {
    ...Typography.variant('meta'),
    flexShrink: 2,
    color: theme.colors.text.secondary,
  },
}));
