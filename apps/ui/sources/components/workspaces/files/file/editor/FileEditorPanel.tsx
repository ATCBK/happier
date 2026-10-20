import * as React from 'react';
import { View } from 'react-native';

import {
  CodeEditorWithFind,
  type CodeEditorWithFindProps,
} from '@/components/ui/code/editor/CodeEditorWithFind';
import {
  ChangeMarkerPeek,
  type ChangeMarkerPeekProps,
} from '@/components/ui/code/editor/ChangeMarkerPeek';
import {
  CodeEditorAccessoryBar,
  type CodeEditorAccessoryBarProps,
} from '@/components/ui/code/editor/chrome/CodeEditorAccessoryBar';
import type { EditorChangeMarkersController } from '@/components/ui/code/editor/useEditorChangeMarkers';
import type { TextEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';

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
  const onChanges = React.useMemo(
    () => (hasMarkers && markers ? markers.next : undefined),
    [hasMarkers, markers],
  );
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View style={{ flex: 1, minHeight: 0 }}>
        <CodeEditorWithFind
          {...editorProps}
          presentation={editorProps.presentation ?? 'canvas'}
          testID={props.testID ?? 'file-details-editor'}
          onChangeMarkersChange={setMarkers}
          onEditorHandleChange={setHandle}
        />
        {markers?.selected ? (
          <ChangeMarkerPeek
            marker={markers.selected}
            controller={markers}
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
