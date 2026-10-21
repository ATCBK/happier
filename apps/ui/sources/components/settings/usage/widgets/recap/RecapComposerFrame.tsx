import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useDeviceType } from '@/utils/platform/responsive';

/** The stage's breathing room around what it shows, on every side. */
export const RECAP_STAGE_INSET_PX = 32;

/**
 * The one geometry behind every Share output (lab s2card C / C1): the stage at the left two-thirds,
 * the choices in a readable column beside it with the note and actions pinned under them. A phone
 * stacks the stage over the choices and keeps the actions in view at the bottom.
 */
export function RecapComposerFrame(
  props: Readonly<{
    stage: React.ReactNode;
    stageTestID?: string;
    /** Wide layouts report the stage's width so a preview can fill it at true proportions. */
    onStageWidth?: (width: number) => void;
    controls: React.ReactNode;
    note: string;
    noteTestID?: string;
    actions: React.ReactNode;
  }>,
): React.ReactElement {
  const phone = useDeviceType() === 'phone';
  const { onStageWidth } = props;
  const stage = (
    <View
      style={[styles.stage, phone ? styles.stagePhone : null]}
      onLayout={
        phone || !onStageWidth
          ? undefined
          : (event) => onStageWidth(Math.round(event.nativeEvent.layout.width))
      }
      testID={props.stageTestID}
    >
      {props.stage}
    </View>
  );
  const controls = <View style={styles.controls}>{props.controls}</View>;
  const footer = (
    <View style={styles.footer}>
      <Text style={styles.note} numberOfLines={2} testID={props.noteTestID}>
        {props.note}
      </Text>
      <View style={styles.actions}>{props.actions}</View>
    </View>
  );
  if (phone) {
    return (
      <View style={styles.fill}>
        <ScrollView
          style={styles.fill}
          contentContainerStyle={styles.phoneContent}
        >
          {stage}
          {controls}
        </ScrollView>
        {footer}
      </View>
    );
  }
  return (
    <View style={[styles.body, styles.fill]}>
      {stage}
      <View style={styles.side}>
        <ScrollView
          style={styles.fill}
          contentContainerStyle={styles.controlsContent}
        >
          {controls}
        </ScrollView>
        {footer}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  fill: { flex: 1, minHeight: 0 },
  body: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: theme.space.s24,
  },
  // Controls keep one readable column beside the stage (lab s2card C: about a third).
  side: {
    width: 340,
    flexShrink: 0,
    minHeight: 0,
  },
  phoneContent: { gap: theme.space.s16, paddingBottom: theme.space.s8 },
  stage: {
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 0,
    alignItems: 'center',
    gap: theme.space.s20,
    paddingVertical: theme.space.s20,
    paddingHorizontal: RECAP_STAGE_INSET_PX,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface.inset,
  },
  stagePhone: { flexGrow: 0, flexBasis: 'auto' },
  controlsContent: {
    paddingBottom: theme.space.s8,
  },
  controls: {
    gap: theme.space.s4,
    minWidth: 280,
  },
  // Inset like the sheet's own header, so the primary action never meets the stage's edge.
  footer: {
    gap: theme.space.s12,
    paddingTop: theme.space.s16,
    paddingHorizontal: theme.space.s16,
    paddingBottom: theme.space.s16,
    marginTop: theme.space.s8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
  note: {
    ...Typography.default(),
    flexShrink: 1,
    color: theme.colors.text.secondary,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
}));
