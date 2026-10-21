import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { useHappierCopyFeedback } from '@happier-dev/plugin-ui/presentation';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import {
  CODE_EDITOR_BASE_FONT_SIZE,
  CODE_EDITOR_BASE_LINE_HEIGHT,
  CODE_EDITOR_TAB_SIZE,
  CODE_GUTTER_METRICS,
} from './codeEditorFontMetrics';
import type { EditorChangeMarker, EditorChangeRevertResult } from './editorChangeMarkers';
import type { EditorChangeMarkersController } from './useEditorChangeMarkers';
import type { HunkReviewChangeActions } from '@/components/workspaces/scm/review/hunkReview/useHunkReviewController';

export type ChangeMarkerActionContext = Readonly<{
  dirty: boolean;
  revertInDraft: EditorChangeMarkersController['revertInDraft'];
  actions?: HunkReviewChangeActions<EditorChangeRevertResult> | null;
}>;

/** Where the peek hangs in its editor region: under (or, near the bottom, over) the marked line. */
export type ChangeMarkerPeekPlacement = Readonly<{ left: number; top: number } | { left: number; bottom: number }>;

/** The peek's tallest frame: eight removed lines under its header. */
export const CHANGE_MARKER_PEEK_MAX_HEIGHT = CODE_EDITOR_BASE_LINE_HEIGHT * 8 + 48;

export type ChangeMarkerPeekProps = Readonly<{
  marker: EditorChangeMarker;
  /** Anchored to the marked line when the engine reports line geometry; docked at the region's foot otherwise. */
  placement?: ChangeMarkerPeekPlacement | null;
  /** Who made the change, from the review owner's attribution ("Claude, turn 3"); omitted when unknown. */
  attribution?: string | null;
  dirty: boolean;
  controller: EditorChangeMarkersController;
  /** The review owner's keyed actions for this change (Keep · Discard · Ask · Copy, P5); the peek draws them. */
  resolveChangeActions?: (marker: EditorChangeMarker, context: ChangeMarkerActionContext) => HunkReviewChangeActions<EditorChangeRevertResult> | null;
  /** The peek's laid-out height, so the editor can open room of that height under the line (view zone). */
  onHeightChange?: (height: number) => void;
}>;

/** Below this frame width the actions leave the header for a row of their own under the removed lines. */
const ONE_ROW_MIN_WIDTH = 440;

/** Each removed line with its number in the old file (ED3 E1: the row reads "20 − const key = …"). */
function removedRowsOf(marker: EditorChangeMarker): ReadonlyArray<Readonly<{ number: number; text: string }>> {
  const rows: Array<Readonly<{ number: number; text: string }>> = [];
  let oldLine = marker.hunk.oldStart;
  for (const line of marker.hunk.lines) {
    if (line.kind === 'remove') rows.push({ number: oldLine, text: line.text });
    if (line.kind !== 'add') oldLine += 1;
  }
  return rows;
}

/** Keeps a line's indentation in a one-line row (which collapses leading white space), so it sits as it did. */
function withVisibleIndent(text: string): string {
  return text.replace(/^[ \t]+/, (indent) => indent.replace(/\t/g, ' '.repeat(CODE_EDITOR_TAB_SIZE)).replace(/ /g, '\u00a0'));
}

function markerSummary(marker: EditorChangeMarker): string {
  const removed = marker.removedLines?.length ?? 0;
  const added =
    marker.kind === 'deleted' ? 0 : marker.endLine - marker.startLine + 1;
  if (marker.kind === 'added')
    return t('files.editing.addedLines', { count: added });
  if (marker.kind === 'deleted')
    return t('files.editing.removedLines', { count: removed });
  return t('files.editing.replacedLines', { count: Math.max(removed, added) });
}

/**
 * The one peek for a change-gutter mark (ade-shell ED3 E1/Ep, P4-R9): what the line held before, who
 * changed it, the way to the next or previous change, and the review owner's actions. Both editor engines
 * open this same host surface from their gutter press; it is never a second engine-side widget.
 */
export const ChangeMarkerPeek = React.memo(function ChangeMarkerPeek(
  props: ChangeMarkerPeekProps,
) {
  const { theme } = useUnistyles();
  const { marker, controller } = props;
  const removed = React.useMemo(() => removedRowsOf(marker), [marker]);
  const context = { dirty: props.dirty, revertInDraft: controller.revertInDraft };
  const actions = props.resolveChangeActions?.(marker, context) ?? null;
  const [oneRow, setOneRow] = React.useState(true);
  const onHeightChange = props.onHeightChange;
  const onFrameLayout = React.useCallback((event: { nativeEvent: { layout: { width: number; height: number } } }) => {
    const next = event.nativeEvent.layout.width >= ONE_ROW_MIN_WIDTH;
    setOneRow((previous) => (previous === next ? previous : next));
    onHeightChange?.(event.nativeEvent.layout.height);
  }, [onHeightChange]);
  const actionRow = actions ? <ChangeMarkerPeekActions marker={marker} actions={actions} /> : null;
  const header = (
    <View style={stylesheet.header}>
      <Text style={stylesheet.summary} numberOfLines={1}>
        <Text style={stylesheet.summaryStrong}>{markerSummary(marker)}</Text>
        {props.attribution ? ` · ${props.attribution}` : ''}
      </Text>
      <View style={stylesheet.headerActions}>
        {oneRow ? actionRow : null}
        <IconButton
          testID="change-marker-peek-previous"
          variant="plain"
          size={28}
          iconSize={14}
          iconName="caret-up"
          accessibilityLabel={t('files.editing.previousChange')}
          onPress={controller.previous}
        />
        <IconButton
          testID="change-marker-peek-next"
          variant="plain"
          size={28}
          iconSize={14}
          iconName="caret-down"
          accessibilityLabel={t('files.editing.nextChange')}
          onPress={controller.next}
        />
        <IconButton
          testID="change-marker-peek-close"
          variant="plain"
          size={28}
          iconSize={14}
          iconName="x"
          accessibilityLabel={t('common.close')}
          onPress={controller.close}
        />
      </View>
    </View>
  );
  return (
    <View
      testID="change-marker-peek"
      style={[stylesheet.frame, props.placement ? { bottom: undefined, ...props.placement } : null]}
      pointerEvents="box-none"
      onLayout={onFrameLayout}
      role="group"
      aria-label={markerSummary(marker)}
    >
      <FloatingOverlay
        header={header}
        footer={!oneRow && actionRow ? <View style={stylesheet.footer}>{actionRow}</View> : undefined}
        maxHeight={CHANGE_MARKER_PEEK_MAX_HEIGHT}
        scrollEnabled={removed.length > 6}
      >
        {removed.length > 0 ? (
          <View style={stylesheet.removed}>
            {removed.map((line, index) => (
              <View
                key={index}
                testID="change-marker-peek-removed-row"
                style={[
                  stylesheet.removedRow,
                  { backgroundColor: theme.colors.diff.removed.background },
                ]}
              >
                <Text
                  style={[
                    stylesheet.oldNumber,
                    { color: theme.colors.diff.removed.border },
                  ]}
                >
                  {line.number}
                </Text>
                <Text
                  style={[
                    stylesheet.code,
                    stylesheet.prefix,
                    { color: theme.colors.diff.removed.border },
                  ]}
                >
                  −
                </Text>
                <Text
                  style={[
                    stylesheet.code,
                    { color: theme.colors.diff.removed.foreground },
                  ]}
                  numberOfLines={1}
                >
                  {withVisibleIndent(line.text)}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </FloatingOverlay>
    </View>
  );
});

/** One presentation notice key for a refused draft Discard whose peek has already closed. */
const REFUSAL_NOTICE_KEY = 'change-marker-peek-refusal';

function refusalMessage(result: unknown): string | null {
  if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== false) return null;
  return 'reason' in result && result.reason === 'moved_on'
    ? t('files.editing.youEditedThisChange')
    : t('hunkReview.noticeUnsupported');
}

/**
 * The change's review verbs in the peek, from P5's keyed actions (the same Keep / Discard as a Changes
 * row, ED3 E1). Discard on an unsaved buffer is one undoable editor edit (offline too); when the person
 * already edited those lines it is refused in place ("You edited this change") and nothing is written.
 */
const ChangeMarkerPeekActions = React.memo(function ChangeMarkerPeekActions(
  props: Readonly<{ marker: EditorChangeMarker; actions: HunkReviewChangeActions<EditorChangeRevertResult> }>,
) {
  const { theme } = useUnistyles();
  const { actions, marker } = props;
  const [refusal, setRefusal] = React.useState<Readonly<{ key: string; message: string }> | null>(null);
  const mountedRef = React.useRef(true);
  React.useEffect(() => () => { mountedRef.current = false; }, []);
  const { markCopied, isCopied } = useHappierCopyFeedback();
  const copied = isCopied();
  const kept = actions.state === 'kept';
  const busy = actions.state === 'discarding';
  const refused = refusal?.key === marker.key ? refusal.message : null;
  const discardReason = actions.discard ? refused ?? actions.disabledReason('discard') : null;
  const keepReason = actions.disabledReason('keep');
  const shownReason = discardReason ?? keepReason;
  const discard = actions.discard;
  const onDiscard = React.useCallback(async () => {
    if (!discard) return;
    const message = refusalMessage(await discard());
    if (!message) return;
    if (mountedRef.current) setRefusal({ key: marker.key, message });
    else publishPresentationNotice({ key: REFUSAL_NOTICE_KEY, message, severity: 'info' });
  }, [discard, marker.key]);
  const onCopy = React.useCallback(() => {
    actions.copy();
    markCopied();
  }, [actions.copy, markCopied]);
  return (
    <View style={stylesheet.actions}>
      {shownReason ? (
        <Text variant="micro" numberOfLines={1} style={[stylesheet.reason, { color: theme.colors.text.secondary }]}>
          {shownReason}
        </Text>
      ) : null}
      {actions.ask ? (
        <IconButton
          testID="change-marker-peek-ask"
          variant="plain"
          size={28}
          iconSize={14}
          iconName="sparkle"
          tooltip={t('hunkReview.askAbout')}
          accessibilityLabel={t('hunkReview.askAbout')}
          onPress={actions.ask}
        />
      ) : null}
      <IconButton
        testID="change-marker-peek-copy"
        variant="plain"
        size={28}
        iconSize={14}
        tooltip={t('hunkReview.copy')}
        accessibilityLabel={t('hunkReview.copy')}
        onPress={onCopy}
        icon={(
          <Icon
            name={copied ? 'check' : 'copy'}
            size={14}
            color={copied ? theme.colors.state.success.foreground : theme.colors.text.secondary}
          />
        )}
      />
      {discard && !kept ? (
        <RoundButton
          testID="change-marker-peek-discard"
          size="mini"
          display="inverted"
          title={t('hunkReview.discard')}
          disabled={busy || discardReason !== null}
          accessibilityHint={discardReason ?? undefined}
          onPress={() => { void onDiscard(); }}
        />
      ) : null}
      <RoundButton
        testID="change-marker-peek-keep"
        size="mini"
        display={kept ? 'inverted' : 'secondary'}
        title={kept ? t('hunkReview.kept') : t('hunkReview.keep')}
        disabled={busy || keepReason !== null}
        accessibilityHint={keepReason ?? undefined}
        onPress={actions.keep}
      />
    </View>
  );
});

const stylesheet = StyleSheet.create((theme) => ({
  frame: {
    position: 'absolute',
    left: theme.space.s12,
    right: theme.space.s12,
    bottom: theme.space.s12,
    alignItems: 'stretch',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingLeft: theme.space.s12,
    paddingRight: theme.space.s4,
    minHeight: 40,
  },
  summary: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
    flex: 1,
    minWidth: 0,
  },
  summaryStrong: {
    ...Typography.variant('meta', 'semiBold'),
    color: theme.colors.text.primary,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
    flexShrink: 1,
    minWidth: 0,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: theme.space.s6,
    flexShrink: 1,
    minWidth: 0,
    marginRight: theme.space.s4,
  },
  reason: {
    flexShrink: 1,
    minWidth: 0,
    marginRight: theme.space.s2,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingLeft: theme.space.s12,
    paddingRight: theme.space.s8,
    paddingVertical: theme.space.s8,
  },
  removed: {
    paddingBottom: theme.space.s4,
  },
  removedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: CODE_EDITOR_BASE_LINE_HEIGHT,
    paddingHorizontal: theme.space.s12,
    gap: theme.space.s8,
  },
  prefix: {
    width: 10,
  },
  oldNumber: {
    ...Typography.mono(),
    fontSize: CODE_GUTTER_METRICS.numberFontSize,
    lineHeight: CODE_EDITOR_BASE_LINE_HEIGHT,
    fontVariant: ['tabular-nums'],
    minWidth: CODE_GUTTER_METRICS.numberMinWidth,
    textAlign: 'right',
  },
  code: {
    ...Typography.mono(),
    fontSize: CODE_EDITOR_BASE_FONT_SIZE,
    lineHeight: CODE_EDITOR_BASE_LINE_HEIGHT,
    flexShrink: 1,
  },
}));
