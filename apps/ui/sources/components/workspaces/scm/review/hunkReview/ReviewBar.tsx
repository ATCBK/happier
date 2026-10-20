import * as React from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FloatingTabBarSurface } from '@/components/ui/navigation/FloatingTabBarSurface';
import { Text } from '@/components/ui/text/Text';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import {
  hapticsLight,
  hapticsSelection,
  hapticsSuccess,
} from '@/components/ui/theme/haptics';
import { t } from '@/text';

export type ReviewBarProps = Readonly<{
  current: number;
  total: number;
  onPrevious?: () => void;
  onNext?: () => void;
  onKeep?: () => void;
  onDiscard?: () => void;
  /** Discard stays in place, disabled, so the bar keeps its shape (offline Machine). */
  discardDisabledReason?: string | null;
  keepDisabledReason?: string | null;
  keepLabel?: string;
  complete?: Readonly<{
    nextFileName?: string | null;
    onNextFile?: () => void;
  }> | null;
  testID?: string;
}>;

/**
 * The phone review bar (lab ade-shell RV3): ‹ 2 of 7 › · Discard · Keep, Keep the one primary.
 * When the file is done it becomes the completion line with Next file as the primary.
 */
export function ReviewBar(props: ReviewBarProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const completeRef = React.useRef(false);
  React.useEffect(() => {
    const complete = Boolean(props.complete);
    if (complete && !completeRef.current) hapticsSuccess();
    completeRef.current = complete;
  }, [props.complete]);

  const body = props.complete ? (
    <View style={styles.row}>
      <Text
        variant="body"
        emphasis="semiBold"
        numberOfLines={2}
        style={[styles.message, { color: theme.colors.text.primary }]}
      >
        {t('hunkReview.fileReviewed')}
      </Text>
      {props.complete.nextFileName && props.complete.onNextFile ? (
        <RoundButton
          testID="review-bar-next-file"
          size="normal"
          title={t('hunkReview.nextFile')}
          accessibilityHint={props.complete.nextFileName}
          onPress={props.complete.onNextFile}
        />
      ) : null}
    </View>
  ) : (
    <View style={styles.row}>
      <IconButton
        testID="review-bar-previous"
        accessibilityLabel={t('hunkReview.previousChange')}
        iconName="caret-left"
        variant="plain"
        iconSize={ICON_SIZE.md}
        disabled={!props.onPrevious}
        onPress={() => {
          hapticsSelection();
          props.onPrevious?.();
        }}
      />
      <Text
        variant="label"
        emphasis="semiBold"
        accessibilityLiveRegion="polite"
        style={[styles.position, { color: theme.colors.text.primary }]}
      >
        {t('hunkReview.counter', {
          current: props.current,
          total: props.total,
        })}
      </Text>
      <IconButton
        testID="review-bar-next"
        accessibilityLabel={t('hunkReview.nextChange')}
        iconName="caret-right"
        variant="plain"
        iconSize={ICON_SIZE.md}
        disabled={!props.onNext}
        onPress={() => {
          hapticsSelection();
          props.onNext?.();
        }}
      />
      <View style={styles.grow} />
      {props.onDiscard ? (
        <RoundButton
          testID="review-bar-discard"
          size="normal"
          display="secondary"
          title={t('hunkReview.discard')}
          disabled={Boolean(props.discardDisabledReason)}
          accessibilityHint={props.discardDisabledReason ?? undefined}
          onPress={() => {
            hapticsLight();
            props.onDiscard?.();
          }}
        />
      ) : null}
      {props.onKeep ? (
        <RoundButton
          testID="review-bar-keep"
          size="normal"
          title={props.keepLabel ?? t('hunkReview.keep')}
          disabled={Boolean(props.keepDisabledReason)}
          accessibilityHint={props.keepDisabledReason ?? undefined}
          onPress={() => {
            hapticsSelection();
            props.onKeep?.();
          }}
        />
      ) : null}
    </View>
  );

  return (
    <View testID={props.testID} pointerEvents="box-none" style={styles.anchor}>
      <FloatingTabBarSurface bottomInset={insets.bottom}>
        {body}
      </FloatingTabBarSurface>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  anchor: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s8,
    paddingVertical: theme.space.s8,
    minWidth: 320,
  },
  position: {
    fontVariant: ['tabular-nums'],
  },
  message: {
    flex: 1,
    paddingLeft: theme.space.s8,
  },
  grow: {
    flex: 1,
  },
}));
