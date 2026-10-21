import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { TextEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { resolveAgentWashColor } from '@/components/ui/code/editor/editorTheme';
import type { CodeLinesAgentPresence } from '@/components/ui/code/view/CodeLinesViewCore';
import { EditorAgentCaret } from '@/components/ui/motion/EditorAgentCaret';

type Placement = Readonly<{
  wash: Readonly<{
    left: number;
    top: number;
    width: number;
    height: number;
  }> | null;
  caret: Readonly<{ left: number; top: number; lineHeight: number }> | null;
}>;

function samePlacement(
  left: Placement | null,
  right: Placement | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const box = (a: Placement['wash'], b: Placement['wash']) =>
    a === b ||
    (!!a &&
      !!b &&
      a.left === b.left &&
      a.top === b.top &&
      a.width === b.width &&
      a.height === b.height);
  const caret =
    left.caret === right.caret ||
    (!!left.caret &&
      !!right.caret &&
      left.caret.left === right.caret.left &&
      left.caret.top === right.caret.top &&
      left.caret.lineHeight === right.caret.lineHeight);
  return box(left.wash, right.wash) && caret;
}

/**
 * Track's agent caret and wash in Edit mode (P5 §3.10): the same presence the read view draws, laid over the editor
 * from its own geometry reads (`getLineRect`, `getPositionRect`) and moved with its scroll through the handle's
 * selection/viewport signal, as the change peek does. An engine without those reads draws nothing.
 */
export function FileEditorAgentPresence(
  props: Readonly<{
    handle: TextEditorHandle | null;
    presence: CodeLinesAgentPresence | null;
  }>,
): React.ReactElement | null {
  const { theme } = useUnistyles();
  const layerRef = React.useRef<View | null>(null);
  const [placement, setPlacement] = React.useState<Placement | null>(null);
  const { handle, presence } = props;
  const startLine = presence?.startLine ?? null;
  const endLine = presence?.endLine ?? null;
  React.useEffect(() => {
    const getLineRect = handle?.getLineRect;
    const getPositionRect = handle?.getPositionRect;
    if (startLine === null || endLine === null || !getLineRect || !handle) {
      setPlacement(null);
      return;
    }
    const update = () => {
      const layer = layerRef.current;
      const first = getLineRect(startLine);
      const last = getLineRect(endLine);
      if (!layer?.measureInWindow || (!first && !last)) {
        setPlacement(null);
        return;
      }
      const text =
        handle.getValue().replace(/\r\n/g, '\n').split('\n')[endLine - 1] ?? '';
      const end = getPositionRect?.(endLine, text.length) ?? null;
      layer.measureInWindow((x, y) => {
        const top = (first ?? last)!;
        const bottom = (last ?? first)!;
        const next: Placement = {
          wash: {
            left: top.x - x,
            top: top.y - y,
            width: top.width,
            height: bottom.y + bottom.height - top.y,
          },
          caret: end
            ? {
                left: end.x - x,
                top: end.y - y,
                lineHeight: end.height || bottom.height,
              }
            : null,
        };
        setPlacement((current) =>
          samePlacement(current, next) ? current : next,
        );
      });
    };
    update();
    return handle.subscribeSelection?.(update);
  }, [endLine, handle, startLine]);
  if (!presence) return null;
  return (
    <View ref={layerRef} pointerEvents="none" style={StyleSheet.absoluteFill}>
      {placement?.wash ? (
        <View
          testID="file-editor-agent-wash"
          style={[
            styles.box,
            placement.wash,
            { backgroundColor: resolveAgentWashColor(theme) },
          ]}
        />
      ) : null}
      {placement?.caret ? (
        <View
          testID="file-editor-agent-caret"
          style={[
            styles.box,
            { left: placement.caret.left, top: placement.caret.top },
          ]}
        >
          <EditorAgentCaret
            key={presence.endLine}
            agentId={presence.agentId}
            agentName={presence.agentName}
            lineHeight={placement.caret.lineHeight}
            reducedMotion={presence.reducedMotion}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    position: 'absolute',
  },
});
