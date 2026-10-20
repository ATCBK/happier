import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import {
  CODE_EDITOR_BASE_FONT_SIZE,
  CODE_EDITOR_BASE_LINE_HEIGHT,
} from './codeEditorFontMetrics';
import type { EditorChangeMarker } from './editorChangeMarkers';
import type { EditorChangeMarkersController } from './useEditorChangeMarkers';

export type ChangeMarkerActionContext = Readonly<{
  dirty: boolean;
  revertInDraft: EditorChangeMarkersController['revertInDraft'];
}>;

export type ChangeMarkerPeekProps = Readonly<{
  marker: EditorChangeMarker;
  /** Who made the change, from the review owner's attribution ("Claude, turn 3"); omitted when unknown. */
  attribution?: string | null;
  dirty: boolean;
  controller: EditorChangeMarkersController;
  /** The review owner's actions for this change (Keep · Discard · Ask · Copy), P5's slot. */
  renderChangeActions?: (
    marker: EditorChangeMarker,
    context: ChangeMarkerActionContext,
  ) => React.ReactNode;
}>;

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
  const removed = marker.removedLines ?? [];
  const header = (
    <View style={stylesheet.header}>
      <Text style={stylesheet.summary} numberOfLines={1}>
        <Text style={stylesheet.summaryStrong}>{markerSummary(marker)}</Text>
        {props.attribution ? ` · ${props.attribution}` : ''}
      </Text>
      <View style={stylesheet.headerActions}>
        {props.renderChangeActions?.(marker, {
          dirty: props.dirty,
          revertInDraft: controller.revertInDraft,
        }) ?? null}
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
      style={stylesheet.frame}
      pointerEvents="box-none"
    >
      <FloatingOverlay
        header={header}
        maxHeight={CODE_EDITOR_BASE_LINE_HEIGHT * 8 + 48}
        scrollEnabled={removed.length > 6}
      >
        {removed.length > 0 ? (
          <View style={stylesheet.removed}>
            {removed.map((line, index) => (
              <View
                key={index}
                style={[
                  stylesheet.removedRow,
                  { backgroundColor: theme.colors.diff.removed.background },
                ]}
              >
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
                  {line}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </FloatingOverlay>
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
    flexShrink: 0,
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
  code: {
    ...Typography.mono(),
    fontSize: CODE_EDITOR_BASE_FONT_SIZE,
    lineHeight: CODE_EDITOR_BASE_LINE_HEIGHT,
    flexShrink: 1,
  },
}));
