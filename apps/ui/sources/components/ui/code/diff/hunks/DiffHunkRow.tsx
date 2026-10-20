import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { resolveCodeMonoFontFamily } from '@/components/ui/code/codeTypography';
import { resolveCodeEditorGutterMetrics } from '@/components/ui/code/editor/codeEditorFontMetrics';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import type { KeyboardCommandId } from '@/keyboard/types';
import { useDeviceType } from '@/utils/platform/responsive';
import { t } from '@/text';
import type {
  DiffHunkAction,
  DiffHunkInfo,
  DiffViewerHunks,
} from '../diffViewerTypes';

/** The row label begins where the code text begins: past the two number columns of a diff gutter. */
const ROW_TEXT_INSET = resolveCodeEditorGutterMetrics({
  lineNumberDigits: 1,
  digitWidth: 0,
  columns: 2,
}).textOffset;

const HoverView = View as unknown as React.ComponentType<
  React.ComponentPropsWithRef<typeof View> & {
    onMouseEnter?: () => void;
    onMouseLeave?: () => void;
    onFocus?: () => void;
    onBlur?: () => void;
  }
>;

export function describeDiffHunkRange(
  hunk: Pick<DiffHunkInfo, 'rangeStart' | 'rangeEnd'>,
): string {
  return hunk.rangeStart === hunk.rangeEnd
    ? t('hunkReview.line', { line: hunk.rangeStart })
    : t('hunkReview.lines', { start: hunk.rangeStart, end: hunk.rangeEnd });
}

function ShortcutHint(
  props: Readonly<{ commandId: KeyboardCommandId; color: string }>,
) {
  const label = useKeyboardShortcutLabel(props.commandId);
  if (!label) return null;
  return (
    <Text
      variant="micro"
      style={{ fontFamily: resolveCodeMonoFontFamily(), color: props.color }}
    >
      {label}
    </Text>
  );
}

/**
 * The one drawing of a change's header row (lab ade-shell RV2): "Change n · lines", Kept state,
 * and Discard / Keep. Quiet until hover or focus, except the current change, which always shows its
 * buttons and the ink edge. Phones show the label only: the review bar and long-press carry actions.
 */
export const DiffHunkRow = React.memo(function DiffHunkRow(
  props: Readonly<{ hunk: DiffHunkInfo; review: DiffViewerHunks }>,
) {
  const { hunk, review } = props;
  const { theme } = useUnistyles();
  const phone = useDeviceType() === 'phone';
  const [revealed, setRevealed] = React.useState(false);
  const state = review.stateOf?.(hunk) ?? 'open';
  const current = review.currentIndex === hunk.index;
  const n = (review.numberOffset ?? 0) + hunk.index + 1;
  const total = review.numberTotal ?? n;
  const range = describeDiffHunkRange(hunk);
  const reason = (action: DiffHunkAction) =>
    review.disabledReason?.(hunk, action) ?? null;
  const keep = review.actions?.keep;
  const discard = review.actions?.discard;
  const kept = state === 'kept';
  const busy = state === 'discarding';
  const showActions = !phone && (keep || discard) && (current || revealed);
  const discardReason = discard ? reason('discard') : null;
  const keepReason = keep ? reason('keep') : null;
  const shownReason = current ? (discardReason ?? keepReason) : null;
  const reveal = React.useCallback(() => setRevealed(true), []);
  const conceal = React.useCallback(() => setRevealed(false), []);
  const hoverHandlers =
    Platform.OS === 'web' && !phone
      ? {
          onMouseEnter: reveal,
          onMouseLeave: conceal,
          onFocus: reveal,
          onBlur: conceal,
        }
      : null;

  return (
    <HoverView
      testID={`diff-hunk-row-${hunk.index}`}
      accessibilityState={{ busy }}
      {...(current ? { 'aria-current': true } : {})}
      style={[
        styles.row,
        current
          ? [
              styles.rowCurrent,
              { borderLeftColor: theme.colors.text.secondary },
            ]
          : null,
        busy ? styles.rowBusy : null,
      ]}
      {...(hoverHandlers ?? {})}
    >
      {kept ? (
        <View style={styles.label}>
          <Icon
            name="check"
            size={ICON_SIZE.xs}
            color={theme.colors.state.success.foreground}
          />
          <Text variant="micro" style={{ color: theme.colors.text.tertiary }}>
            {t('hunkReview.kept')}
          </Text>
          <Text
            variant="micro"
            numberOfLines={1}
            style={{
              color: theme.colors.text.tertiary,
              fontVariant: ['tabular-nums'],
            }}
          >{`· ${range}`}</Text>
        </View>
      ) : (
        <View style={styles.label}>
          <Text
            variant="micro"
            emphasis="semiBold"
            style={{
              color: current
                ? theme.colors.text.primary
                : theme.colors.text.secondary,
              fontVariant: ['tabular-nums'],
            }}
          >
            {t('hunkReview.change', { n })}
          </Text>
          <Text
            variant="micro"
            numberOfLines={1}
            style={{
              color: theme.colors.text.tertiary,
              fontVariant: ['tabular-nums'],
            }}
          >{`· ${range}`}</Text>
        </View>
      )}
      <View style={styles.grow} />
      {shownReason ? (
        <Text
          variant="micro"
          numberOfLines={1}
          style={[styles.reason, { color: theme.colors.text.secondary }]}
        >
          {shownReason}
        </Text>
      ) : null}
      {!phone && (keep || discard) ? (
        <View
          style={[styles.actions, showActions ? null : styles.actionsQuiet]}
          pointerEvents={showActions ? 'auto' : 'box-none'}
        >
          {discard && !kept ? (
            <RoundButton
              testID={`diff-hunk-discard-${hunk.index}`}
              size="mini"
              display="inverted"
              title={t('hunkReview.discard')}
              trailing={
                <ShortcutHint
                  commandId="review.change.discard"
                  color={theme.colors.text.tertiary}
                />
              }
              disabled={busy || discardReason !== null}
              accessibilityLabel={t('hunkReview.discardA11y', {
                n,
                total,
                range,
              })}
              accessibilityHint={discardReason ?? undefined}
              onPress={() => discard(hunk)}
            />
          ) : null}
          {keep ? (
            <RoundButton
              testID={`diff-hunk-keep-${hunk.index}`}
              size="mini"
              display={kept ? 'inverted' : 'secondary'}
              title={kept ? t('hunkReview.kept') : t('hunkReview.keep')}
              trailing={
                <ShortcutHint
                  commandId="review.change.keep"
                  color={theme.colors.text.tertiary}
                />
              }
              disabled={busy || keepReason !== null}
              accessibilityLabel={
                kept
                  ? t('hunkReview.unkeepA11y', { n, total, range })
                  : t('hunkReview.keepA11y', { n, total, range })
              }
              accessibilityHint={keepReason ?? undefined}
              onPress={() => keep(hunk)}
            />
          ) : null}
        </View>
      ) : null}
    </HoverView>
  );
});

/** Module-scope renderer handed to `useDiffHunkSlots`, so the slot identity stays stable. */
export function renderDiffHunkRow(
  hunk: DiffHunkInfo,
  review: DiffViewerHunks,
): React.ReactNode {
  if (!review.actions?.keep && !review.actions?.discard && !review.stateOf)
    return null;
  return <DiffHunkRow key={hunk.key} hunk={hunk} review={review} />;
}

const styles = StyleSheet.create((theme) => ({
  row: {
    minHeight: 30,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingLeft: ROW_TEXT_INSET,
    paddingRight: theme.space.s12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
    borderLeftWidth: 2,
    borderLeftColor: 'transparent',
  },
  rowCurrent: {
    backgroundColor: theme.colors.surface.selected,
  },
  rowBusy: {
    opacity: 0.6,
  },
  label: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
    flexShrink: 1,
    minWidth: 0,
  },
  grow: {
    flex: 1,
  },
  reason: {
    flexShrink: 1,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
  },
  actionsQuiet: {
    opacity: 0,
  },
}));
