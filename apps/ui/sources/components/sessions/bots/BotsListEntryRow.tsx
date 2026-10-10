import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { Avatar } from '@/components/ui/avatar/Avatar';
import { AvatarStack } from '@/components/ui/avatar/AvatarStack';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { useOptionalBotsRosterRuntime } from './BotsRosterRuntime';
import { BOTS_GLYPH } from './botsGlyph';
import { useBotsSummary } from './botsSummary';

const FACE_SIZE_PX = 20;

/**
 * The phone's way to the Bots roster from My work (lab `b-rail Ap`): one row at the top of the list,
 * the Bots glyph, a few faces and what needs you, opening the same roster sheet the compact navigation
 * opens. It reads only the closed-entry summary; the roster mounts when it opens.
 */
export const BotsListEntryRow = React.memo(function BotsListEntryRow() {
  const { theme } = useUnistyles();
  const runtime = useOptionalBotsRosterRuntime();
  const summary = useBotsSummary();
  if (!runtime) return null;
  const needsYou =
    summary.needsYou > 0
      ? t('bots.roster.needsYou', { count: summary.needsYou })
      : null;
  return (
    <ItemGroup>
      <Item
        testID="bots-list-entry"
        icon={<Icon name={BOTS_GLYPH} />}
        title={t('bots.title')}
        accessibilityLabel={
          needsYou ? `${t('bots.title')}, ${needsYou}` : t('bots.title')
        }
        onPress={runtime.open}
        showDivider={false}
        rightElement={
          summary.faces.length > 0 || needsYou ? (
            <View style={styles.detail}>
              {summary.faces.length > 0 ? (
                <AvatarStack
                  size={FACE_SIZE_PX}
                  entries={summary.faces.map((face) => ({
                    key: face.key,
                    content: <Avatar id={face.avatarId} size={FACE_SIZE_PX} />,
                  }))}
                />
              ) : null}
              {needsYou ? (
                <View style={styles.summary}>
                  <StatusDot color={theme.colors.state.warning.foreground} />
                  <Text
                    testID="bots-list-entry.needs-you"
                    style={styles.summaryText}
                    numberOfLines={1}
                  >
                    {needsYou}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : undefined
        }
      />
    </ItemGroup>
  );
});

const styles = StyleSheet.create((theme) => ({
  detail: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.margins.sm,
    flexShrink: 1,
  },
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.margins.xs,
    flexShrink: 1,
  },
  summaryText: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
}));
