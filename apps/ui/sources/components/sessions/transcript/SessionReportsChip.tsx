import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HAPPIER_BADGE_METRICS,
  HappierPressable,
} from '@happier-dev/plugin-ui/presentation';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useOptionalAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { useDestinationPaneScopeId } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useOpenSessionAgents } from '@/components/sessions/agents/navigation/useOpenSessionAgents';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { Icon } from '@/components/ui/icons/Icon';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { useSessionSelector } from '@/sync/store/hooks';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/**
 * The Sessions this Session started, at the end of its transcript (lab `b-launch`, D43 (3)): one quiet
 * "Sessions · N" chip that opens the Agents surface, where the Work tab already lists them and the
 * Sessions list already nests or filters them. The count is the Session's own `reports.total` — the same
 * fact the list row reads — so the chip subscribes to one number and renders nothing without children.
 */
export const SessionReportsChip = React.memo(function SessionReportsChip(
  props: Readonly<{
    sessionId: string;
    serverId?: string | null;
  }>,
) {
  const count = useSessionSelector(
    props.sessionId,
    props.serverId,
    (session) => session?.managedSessions?.total ?? 0,
  );
  const hasPaneHost = useOptionalAppPaneContext(() => true) !== null;
  if (count <= 0) return null;
  return hasPaneHost ? (
    <PaneReportsChip {...props} count={count} />
  ) : (
    <RoutedReportsChip {...props} count={count} />
  );
});

type ChipProps = Readonly<{
  sessionId: string;
  serverId?: string | null;
  count: number;
}>;

/** Beside a mounted Session the Agents tab opens in its own pane (or the phone cockpit's surface). */
function PaneReportsChip(props: ChipProps) {
  const paneScopeId = useDestinationPaneScopeId(
    createSessionPaneScopeId(props.sessionId, props.serverId ?? null),
  );
  const pane = useAppPaneScope(paneScopeId);
  const open = useOpenSessionAgents({ target: props, pane });
  return <ReportsChipButton count={props.count} onPress={open} />;
}

/** Without a pane host the same opener lands on the Agents route. */
function RoutedReportsChip(props: ChipProps) {
  const open = useOpenSessionAgents({ target: props });
  return <ReportsChipButton count={props.count} onPress={open} />;
}

function ReportsChipButton(props: Readonly<{ count: number; onPress: () => void }>) {
  const { theme } = useUnistyles();
  const label = t('sessionWork.list.transcriptSessions', { count: props.count });
  // The transcript's own column, so the chip sits on the message text's edge (MessageView).
  const columnStyle = useLayoutMaxWidthStyle();
  return (
    <View style={styles.row}>
      <View style={[styles.column, columnStyle]}>
        <HappierPressable
          testID="transcript-session-reports-chip"
          accessibilityRole="button"
          accessibilityLabel={label}
          onPress={props.onPress}
          style={({ focused, pressed }) => [
            styles.chip,
            focusRingStyle({ focused, color: theme.colors.border.focus }),
            { opacity: pressed ? motionTokens.press.opacitySubtle : 1 },
          ]}
        >
          <StatusPill
            variant="neutral"
            hideDot
            label={label}
            labelVariant="phrase"
            labelStyle={styles.label}
            trailing={<Icon name="caret-right" size={12} color={theme.colors.text.tertiary} />}
          />
        </HappierPressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    justifyContent: 'center',
    paddingTop: theme.space.s4,
    paddingBottom: theme.space.s8,
  },
  column: {
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 0,
    alignItems: 'flex-start',
    paddingHorizontal: theme.space.s16,
  },
  chip: { borderRadius: HAPPIER_BADGE_METRICS.radius },
  // A control in the transcript reads at body size, a step above the status-pill phrase.
  label: { ...Typography.variant('body', 'medium') },
}));
