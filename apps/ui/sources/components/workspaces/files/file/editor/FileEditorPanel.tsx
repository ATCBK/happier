import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

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
import {
  MarkdownCodeEditorField,
  type MarkdownCodeEditorFieldProps,
} from '@/components/ui/markdown/editor/MarkdownCodeEditorField';

/** The gutter peek's facts and the review owner's keyed actions (ade-shell ED3). */
export type FileEditorPeekProps = Pick<ChangeMarkerPeekProps, 'attribution' | 'resolveChangeActions'> &
  Readonly<{ dirty: boolean }>;

export type FileEditorPanelProps = CodeEditorWithFindProps &
  Readonly<{
    theme?: unknown;
    /** Phone composition: the key row sits on the keyboard with Save pinned (files lab ED1p). */
    accessory?: Readonly<{ save: CodeEditorAccessoryBarProps['save'] }> | null;
    peek?: FileEditorPeekProps;
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
  const onChanges = React.useMemo(
    () => (hasMarkers && markers ? markers.next : undefined),
    [hasMarkers, markers],
  );
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <FileEditorPeekRegion markers={markers} handle={handle} peek={peek}>
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
      </FileEditorPeekRegion>
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

/**
 * The raw Markdown editor on the File page with the same change gutter peek as code (P4-R9): its marker
 * controller and handle come from the raw source editor, so rich mode (no gutter) shows no peek.
 */
export const FileMarkdownEditorPanel = React.memo(function FileMarkdownEditorPanel(
  props: MarkdownCodeEditorFieldProps & Readonly<{ peek?: FileEditorPeekProps }>,
) {
  const { peek, ...fieldProps } = props;
  const [markers, setMarkers] = React.useState<EditorChangeMarkersController | null>(null);
  const [handle, setHandle] = React.useState<TextEditorHandle | null>(null);
  return (
    <FileEditorPeekRegion markers={markers} handle={handle} peek={peek}>
      <MarkdownCodeEditorField {...fieldProps} onChangeMarkersChange={setMarkers} onEditorHandleChange={setHandle} />
    </FileEditorPeekRegion>
  );
});

/** The editor region the one peek hangs in: the peek is measured against this box and its marked line. */
function FileEditorPeekRegion(
  props: Readonly<{
    markers: EditorChangeMarkersController | null;
    handle: TextEditorHandle | null;
    peek?: FileEditorPeekProps;
    children: React.ReactNode;
  }>,
) {
  const { markers, peek } = props;
  const { theme } = useUnistyles();
  const regionRef = React.useRef<View>(null);
  const [peekHeight, setPeekHeight] = React.useState<number | null>(null);
  const selected = markers?.selected ?? null;
  const { placement, zoned } = useChangeMarkerPeekPlacement(regionRef, props.handle, selected, peekHeight, theme.space.s6);
  return (
    // The peek sits in the editor's own room for it, so it scrolls out of the region with the text.
    <View ref={regionRef} style={{ flex: 1, minHeight: 0, overflow: zoned && selected ? 'hidden' : undefined }}>
      {props.children}
      {selected && markers ? (
        <ChangeMarkerPeek
          marker={selected}
          controller={markers}
          placement={placement}
          dirty={peek?.dirty ?? false}
          attribution={peek?.attribution}
          resolveChangeActions={peek?.resolveChangeActions}
          onHeightChange={setPeekHeight}
        />
      ) : null}
    </View>
  );
}

/** Gap between the peek and the code column's left edge, so its first words sit just before the text. */
const PEEK_LEADING_OFFSET = 4;

/** The line a change's room opens after: its last line, or the line a deletion sits after (0 = above line 1). */
function peekZoneAfterLine(marker: EditorChangeMarker): number {
  if (marker.kind !== 'deleted') return marker.endLine;
  return marker.anchor === 'before' ? 0 : marker.startLine;
}

/**
 * Hangs the peek from the marked line (ade-shell ED3 E1). An engine with peek zones opens room of the peek's
 * height under the line, so the following lines move down and the peek sits in that room; without zones the peek
 * floats under the line (over it near the region's foot), and an engine without line geometry keeps it docked.
 * Follows the editor's scroll through the handle's selection/viewport signal.
 */
function useChangeMarkerPeekPlacement(
  regionRef: React.RefObject<View | null>,
  handle: TextEditorHandle | null,
  marker: EditorChangeMarker | null,
  peekHeight: number | null,
  zoneGap: number,
): Readonly<{ placement: ChangeMarkerPeekPlacement | null; zoned: boolean }> {
  const [placement, setPlacement] = React.useState<ChangeMarkerPeekPlacement | null>(null);
  const setPeekZone = handle?.setPeekZone;
  const getPeekZoneRect = handle?.getPeekZoneRect;
  const zoned = Boolean(setPeekZone && getPeekZoneRect);
  React.useEffect(() => {
    if (!marker || !setPeekZone || !getPeekZoneRect) return;
    return () => setPeekZone(null);
  }, [marker, setPeekZone, getPeekZoneRect]);
  React.useEffect(() => {
    if (!marker || !setPeekZone || !getPeekZoneRect || peekHeight === null) return;
    setPeekZone({ afterLine: peekZoneAfterLine(marker), firstLine: marker.startLine, height: peekHeight + 2 * zoneGap });
  }, [marker, peekHeight, setPeekZone, getPeekZoneRect, zoneGap]);
  React.useEffect(() => {
    const getLineRect = handle?.getLineRect;
    if (!marker || (!getLineRect && !getPeekZoneRect)) { setPlacement(null); return; }
    const line = marker.kind === 'deleted' ? marker.startLine : marker.endLine;
    const update = () => {
      const zone = getPeekZoneRect?.() ?? null;
      const rect = zone ?? getLineRect?.(line) ?? null;
      const region = regionRef.current;
      if (!rect || !region?.measureInWindow) { setPlacement(null); return; }
      region.measureInWindow((x, y, _width, height) => {
        const left = Math.max(0, rect.x - x - PEEK_LEADING_OFFSET);
        const below = rect.y - y + rect.height;
        const next: ChangeMarkerPeekPlacement = zone
          ? { left, top: zone.y - y + zoneGap }
          : below + CHANGE_MARKER_PEEK_MAX_HEIGHT <= height
            ? { left, top: Math.max(0, below) }
            : { left, bottom: Math.max(0, height - (rect.y - y)) };
        setPlacement((current) => current && current.left === next.left
          && ('top' in current ? 'top' in next && current.top === next.top : 'bottom' in next && current.bottom === next.bottom)
          ? current : next);
      });
    };
    update();
    return handle?.subscribeSelection?.(update);
  }, [handle, marker, regionRef, getPeekZoneRect, zoneGap]);
  return { placement, zoned };
}
