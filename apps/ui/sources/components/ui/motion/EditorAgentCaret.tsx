import {
  HAPPIER_TYPE_SCALE,
  type HappierAgentCursorMotion,
  type HappierAgentCursorMotionDriver,
} from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { reanimatedAgentCursorMotion } from './reanimatedAgentCursorMotion';

/** The flag sits on the caret's line: the micro role's line box with a hairline of air above and below. */
const FLAG_HEIGHT = HAPPIER_TYPE_SCALE.micro.lineHeight + 2;

export type EditorAgentCaretProps = Readonly<{
  agentId: string | null;
  agentName: string;
  /** The code line's height, so the caret stands on the line's text box. */
  lineHeight: number;
  /**
   * Where the caret stood before this region, relative to here (negative = above). It travels from there on
   * the travel spring; omitted (first arrival), it fades in.
   */
  travelFromPx?: number;
  reducedMotion: boolean;
  /** The host's motion for the shared agent cursor; tests pass a recording driver through the same seam. */
  motionDriver?: HappierAgentCursorMotionDriver;
  testID?: string;
}>;

/**
 * The agent's text caret in code (P5 §3.10, lab tr T1): an ink bar where the agent writes and a flag with its mark
 * and name. Host-private; it reuses the agent cursor's motion seam (travel spring, fast fade) rather than giving
 * the public `AgentCursor` a text-caret mode. It jumps to each edit region (tool input is complete when the call
 * starts) and never follows keystrokes. Reduced motion: it appears in place with a cross-fade, no travel.
 */
export function EditorAgentCaret(
  props: EditorAgentCaretProps,
): React.ReactElement {
  return props.motionDriver ? (
    <EditorAgentCaretLayer {...props} driver={props.motionDriver} />
  ) : (
    <EditorAgentCaretLayer {...props} driver={reanimatedAgentCursorMotion} />
  );
}

function EditorAgentCaretLayer<Motion extends HappierAgentCursorMotion>(
  props: EditorAgentCaretProps &
    Readonly<{ driver: HappierAgentCursorMotionDriver<Motion> }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const driver = props.driver;
  const motion = driver.useMotion();
  const { reducedMotion, travelFromPx } = props;
  React.useLayoutEffect(() => {
    if (reducedMotion) {
      motion.set('y', 0);
      motion.setOpacity('pointer', 0);
      motion.fade('pointer', 1, 'standard');
    } else if (typeof travelFromPx === 'number' && travelFromPx !== 0) {
      motion.setOpacity('pointer', 1);
      motion.set('y', travelFromPx);
      motion.travel('y', 0);
    } else {
      motion.setOpacity('pointer', 0);
      motion.fade('pointer', 1, 'standard');
    }
    // One arrival per mounted region: a new region mounts a new caret on its own line.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const barHeight = Math.min(props.lineHeight, FLAG_HEIGHT + 2);
  const ink = theme.colors.text.primary;
  const onInk = theme.colors.surface.base;
  return (
    <driver.Pointer
      motion={motion}
      style={[styles.root, { marginTop: (props.lineHeight - barHeight) / 2 }]}
      testID={`${props.testID ?? 'editor-agent-caret'}.motion`}
    >
      <View
        testID={props.testID ?? 'editor-agent-caret'}
        accessible
        accessibilityRole="text"
        accessibilityLabel={t('files.track.caretA11y', {
          agent: props.agentName,
        })}
        pointerEvents="none"
        style={[styles.bar, { height: barHeight, backgroundColor: ink }]}
      >
        <View
          style={[
            styles.flag,
            {
              height: FLAG_HEIGHT,
              backgroundColor: ink,
              paddingHorizontal: theme.space.s6,
              gap: theme.space.s4,
            },
          ]}
        >
          {props.agentId ? (
            <AgentIcon
              agentId={props.agentId}
              size={HAPPIER_TYPE_SCALE.micro.fontSize}
              color={onInk}
            />
          ) : null}
          <Text
            variant="micro"
            emphasis="semiBold"
            numberOfLines={1}
            style={{ color: onInk }}
          >
            {props.agentName}
          </Text>
        </View>
      </View>
    </driver.Pointer>
  );
}

const styles = StyleSheet.create({
  root: {
    zIndex: 1,
    alignSelf: 'flex-start',
  },
  bar: {
    width: 2,
    borderRadius: 1,
  },
  flag: {
    position: 'absolute',
    left: 4,
    top: 0,
    borderRadius: 4,
    flexDirection: 'row',
    alignItems: 'center',
  },
});
