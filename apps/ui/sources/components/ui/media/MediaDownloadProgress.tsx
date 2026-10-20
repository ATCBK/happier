import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { MeterBar } from '@/components/ui/lists/MeterBar';
import {
  SurfaceStateCard,
  type SurfaceStateAction,
} from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { getPreferredLanguage, t } from '@/text';

import type { FilePreviewProgress } from './useFilePreviewSource';

/** "2.1" and "8.4" (megabytes, one decimal, the reader's locale) for "2.1 of 8.4 MB". */
export function formatPreviewProgressMegabytes(
  progress: FilePreviewProgress,
): Readonly<{ loaded: string; total: string }> {
  let format: (value: number) => string;
  try {
    const numberFormat = new Intl.NumberFormat([getPreferredLanguage()], {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
    format = (value) => numberFormat.format(value);
  } catch {
    format = (value) => value.toFixed(1);
  }
  const total = Math.max(0, progress.totalBytes);
  return {
    loaded: format(
      Math.min(total, Math.max(0, progress.receivedBytes)) / 1_000_000,
    ),
    total: format(total / 1_000_000),
  };
}

export function previewProgressFraction(progress: FilePreviewProgress): number {
  return progress.totalBytes > 0
    ? Math.min(1, progress.receivedBytes / progress.totalBytes)
    : 0;
}

/**
 * Bytes on their way to a player (lab files FV6d): "Downloading 2.1 of 8.4 MB", a 4-tall ink bar, Cancel.
 * Phones drop the verb ("2.1 of 8.4 MB"); the bar and Cancel keep their places.
 */
export function MediaDownloadLine(
  props: Readonly<{
    progress: FilePreviewProgress;
    onCancel: () => void;
    compact?: boolean;
    testID?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const amounts = formatPreviewProgressMegabytes(props.progress);
  const label = props.compact
    ? t('files.viewer.megabytesOf', amounts)
    : t('files.viewer.downloading', amounts);
  return (
    <View testID={props.testID} style={styles.row}>
      <Text
        variant="meta"
        numberOfLines={1}
        style={[styles.label, { color: theme.colors.text.secondary }]}
      >
        {label}
      </Text>
      <MeterBar
        tone="neutral"
        animated
        fillFraction={previewProgressFraction(props.progress)}
        fillColor={theme.colors.text.secondary}
        height={4}
        progressAccessibilityLabel={label}
        style={styles.bar}
      />
      <TextLinkButton
        label={t('common.cancel')}
        tone="strong"
        size="meta"
        onPress={props.onCancel}
        {...(props.testID ? { testID: `${props.testID}-cancel` } : {})}
      />
    </View>
  );
}

/** After Cancel: the file stays a calm page that can load again (and hand off when the body can). */
export function MediaLoadStoppedState(
  props: Readonly<{
    title: string;
    onLoadAgain: () => void;
    handoff?: SurfaceStateAction;
    testID?: string;
  }>,
) {
  return (
    <SurfaceStateCard
      {...(props.testID ? { testID: props.testID } : {})}
      kind="unavailable"
      size="pane"
      iconName="download"
      title={t('files.viewer.loadStopped', { name: props.title })}
      action={{
        label: t('files.viewer.loadAgain'),
        onPress: props.onLoadAgain,
      }}
      {...(props.handoff ? { secondaryAction: props.handoff } : {})}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s10,
  },
  label: {
    fontVariant: ['tabular-nums'],
  },
  bar: {
    flex: 1,
    minWidth: theme.space.s32,
  },
}));
