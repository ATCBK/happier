import * as React from 'react';
import { View } from 'react-native';

import {
  CodeEditorWithFind,
  type CodeEditorWithFindProps,
} from '@/components/ui/code/editor/CodeEditorWithFind';
import {
  CHANGE_MARKER_PEEK_MAX_HEIGHT,
  ChangeMarkerPeek,
  type ChangeMarkerPeekPlacement,
  type ChangeMarkerPeekProps,
} from '@/components/ui/code/editor/ChangeMarkerPeek';
import type { EditorChangeMarker } from '@/components/ui/code/editor/editorChangeMarkers';
import {
  CodeEditorAccessoryBar,
  type CodeEditorAccessoryBarProps,
} from '@/components/ui/code/editor/chrome/CodeEditorAccessoryBar';
import type { EditorChangeMarkersController } from '@/components/ui/code/editor/useEditorChangeMarkers';
import type { TextEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { CODE_CANVAS_CONTENT_PADDING } from '@/components/ui/code/editor/codeEditorFontMetrics';

export type FileEditorPanelProps = CodeEditorWithFindProps &
  Readonly<{
    theme?: unknown;
    /** Phone composition: the key row sits on the keyboard with Save pinned (files lab ED1p). */
    accessory?: Readonly<{ save: CodeEditorAccessoryBarProps['save'] }> | null;
    /** The gutter peek's facts and the review owner's action slot (ade-shell ED3). */
    peek?: Pick<ChangeMarkerPeekProps, 'attribution' | 'renderChangeActions'> &
      Readonly<{ dirty: boolean }>;
  }>;

/**
 * The File page's editor region (P4 U5/U6): the editor on the page's own canvas so View → Edit keeps the
 * text where it was, the change gutter's one peek, and on phones the key row above the keyboard.
 */
export const FileEditorPanel = React.memo(function FileEditorPanel(
  props: FileEditorPanelProps,
) {
  const { accessory, peek, theme: _theme, ...editorProps } = props;
  const [markers, setMarkers] =
    React.useState<EditorChangeMarkersController | null>(null);
  const [handle, setHandle] = React.useState<TextEditorHandle | null>(null);
  const hasMarkers = (props.changeMarkers?.items.length ?? 0) > 0;
  const regionRef = React.useRef<View>(null);
  const placement = useChangeMarkerPeekPlacement(regionRef, handle, markers?.selected ?? null);
  const onChanges = React.useMemo(
    () => (hasMarkers && markers ? markers.next : undefined),
    [hasMarkers, markers],
  );
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View ref={regionRef} style={{ flex: 1, minHeight: 0 }}>
        <CodeEditorWithFind
          {...editorProps}
          presentation={editorProps.presentation ?? 'canvas'}
          // The code view's own inset: the first line and the numbers stay where View drew them.
          contentPaddingHorizontal={editorProps.contentPaddingHorizontal ?? CODE_CANVAS_CONTENT_PADDING}
          contentPaddingVertical={editorProps.contentPaddingVertical ?? CODE_CANVAS_CONTENT_PADDING}
          testID={props.testID ?? 'file-details-editor'}
          onChangeMarkersChange={setMarkers}
          onEditorHandleChange={setHandle}
        />
        {markers?.selected ? (
          <ChangeMarkerPeek
            marker={markers.selected}
            controller={markers}
            placement={placement}
            dirty={peek?.dirty ?? false}
            attribution={peek?.attribution}
            renderChangeActions={peek?.renderChangeActions}
          />
        ) : null}
      </View>
      {accessory ? (
        <CodeEditorAccessoryBar
          editor={handle}
          save={accessory.save}
          onChanges={onChanges}
        />
      ) : null}
    </View>
  );
});

/** Gap between the peek and the code column's left edge, so its first words sit just before the text. */
const PEEK_LEADING_OFFSET = 4;

/**
 * Hangs the peek from the marked line (ade-shell ED3 E1): under its last row, or over it when the line is
 * near the region's foot. Follows the editor's scroll through the handle's selection/viewport signal. An
 * engine without line geometry (`getLineRect` absent) keeps the docked peek.
 */
function useChangeMarkerPeekPlacement(
  regionRef: React.RefObject<View | null>,
  handle: TextEditorHandle | null,
  marker: EditorChangeMarker | null,
): ChangeMarkerPeekPlacement | null {
  const [placement, setPlacement] = React.useState<ChangeMarkerPeekPlacement | null>(null);
  React.useEffect(() => {
    const getLineRect = handle?.getLineRect;
    if (!marker || !getLineRect) { setPlacement(null); return; }
    const line = marker.kind === 'deleted' ? marker.startLine : marker.endLine;
    const update = () => {
      const rect = getLineRect(line);
      const region = regionRef.current;
      if (!rect || !region?.measureInWindow) { setPlacement(null); return; }
      region.measureInWindow((x, y, _width, height) => {
        const left = Math.max(0, rect.x - x - PEEK_LEADING_OFFSET);
        const below = rect.y - y + rect.height;
        const next: ChangeMarkerPeekPlacement = below + CHANGE_MARKER_PEEK_MAX_HEIGHT <= height
          ? { left, top: Math.max(0, below) }
          : { left, bottom: Math.max(0, height - (rect.y - y)) };
        setPlacement((current) => current && current.left === next.left
          && ('top' in current ? 'top' in next && current.top === next.top : 'bottom' in next && current.bottom === next.bottom)
          ? current : next);
      });
    };
    update();
    return handle?.subscribeSelection?.(update);
  }, [handle, marker, regionRef]);
  return placement;
}
