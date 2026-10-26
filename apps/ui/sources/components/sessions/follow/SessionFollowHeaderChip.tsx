import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { SESSION_HEADER_ICON_SIZE_PX } from '@/components/sessions/actions/sessionHeaderIconMetrics';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { Icon } from '@/components/ui/icons/Icon';
import { useSessionSelector } from '@/sync/store/hooks';
import { t } from '@/text';

import {
  readSessionFollowHeaderPreset,
  type SessionFollowHeaderPreset,
} from './sessionFollowHeaderPreset';

/** The Follow level in words, shared by the header chip and Info's Follow row. */
export function sessionFollowPresetLabel(preset: SessionFollowHeaderPreset): string {
  switch (preset) {
    case 'none': return t('session.follow.follow');
    case 'everything': return t('session.follow.policy.everything');
    case 'important': return t('session.follow.policy.important');
    case 'quiet': return t('session.follow.policy.quiet');
    case 'custom': return t('session.follow.policy.custom');
  }
}

/**
 * The session header's Follow chip (lab P2-A): how much you hear about this session, opening the one
 * shared Follow editor. Wide headers show the level ("Important ⌄"); folded phone headers keep the
 * bell, which pushes the Follow page. Reads only the synced viewer facts, never a Follow request.
 */
export function SessionFollowHeaderChip(
  props: Readonly<{
    sessionId: string;
    serverId: string | null;
    compact: boolean;
    anchorRef: React.RefObject<View | null>;
    open: boolean;
    onPress: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const preset = useSessionSelector(
    props.sessionId,
    props.serverId,
    (session) => (session ? readSessionFollowHeaderPreset(session) : null),
  );
  if (preset === null) return null;
  const label = sessionFollowPresetLabel(preset);
  const glyph = (
    <Icon
      name={preset === 'none' ? 'bell-slash' : 'bell'}
      size={props.compact ? SESSION_HEADER_ICON_SIZE_PX : 14}
      color={theme.colors.chrome.header.foreground}
    />
  );
  return (
    <View ref={props.anchorRef} collapsable={false}>
      {props.compact ? (
        <IconButton
          testID="session-header-follow-chip"
          icon={glyph}
          variant="plain"
          accessibilityLabel={t('session.follow.editor.title')}
          tooltip={label}
          expanded={props.open}
          // The header keeps 6 px between its actions: neighbouring hit areas split it.
          interactiveTargetGapPx={6}
          onPress={props.onPress}
        />
      ) : (
        <ToolbarButton
          testID="session-header-follow-chip"
          label={label}
          icon={glyph}
          trailing={
            <Icon
              name="caret-down"
              size={12}
              color={theme.colors.text.secondary}
            />
          }
          active={props.open}
          accessibilityLabel={`${t('session.follow.editor.title')}: ${label}`}
          onPress={props.onPress}
        />
      )}
    </View>
  );
}
