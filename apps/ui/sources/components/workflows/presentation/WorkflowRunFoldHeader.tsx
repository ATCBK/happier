import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HappierPressable,
  HAPPIER_PRESS_FEEDBACK_V1,
  isHappierPageRowNarrow,
  isHappierPageRowAccessoryStacked,
  type HappierDisclosureHeaderState,
} from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { ExpandableItemCaret } from '@/components/ui/lists/ExpandableItem';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { resolveThemeHairlineBorderStyle } from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { WorkflowPurposeGlyph } from './WorkflowPurposeGlyph';
import type { WorkflowTriggerRunFoldPresentation } from './workflowTriggerRunFoldPresentation';

/**
 * The one in-thread band for a managed Workflow Run: its purpose glyph, what it is and how it ended, and
 * Open. A Session transcript folds the Run's turns under it; a Discussion shows it under the message that
 * started the Run, with Another round when the Run offers it.
 */
export function WorkflowRunFoldHeader(
  props: Readonly<{
    runId: string;
    /** Absent for a run with nothing to expand. */
    disclosure: Readonly<{
      expanded: boolean;
      headerProps: HappierDisclosureHeaderState['headerProps'];
    }> | null;
    presentation: WorkflowTriggerRunFoldPresentation;
    /** Opens the exact Run; null where this surface cannot navigate. */
    onOpen: (() => void) | null;
    /** Further row operations (Another round), placed before Open. */
    actions?: React.ReactNode;
  }>,
) {
  const { theme } = useUnistyles();
  const [headerWidth, setHeaderWidth] = React.useState<number | null>(null);
  const [actionsWidth, setActionsWidth] = React.useState<number | null>(null);
  const onLayout = React.useCallback((event: LayoutChangeEvent) => {
    setHeaderWidth(event.nativeEvent.layout.width);
  }, []);
  const onActionsLayout = React.useCallback((event: LayoutChangeEvent) => {
    setActionsWidth(event.nativeEvent.layout.width);
  }, []);
  const narrow = isHappierPageRowNarrow(headerWidth);
  const open = props.onOpen;
  const hasActions = props.actions != null;
  // The row's operations never squeeze out what the Run is: by the page row rule for operations they
  // move beneath the line when they would leave it less than its label column. Open, short, stays.
  const stacked = hasActions && isHappierPageRowAccessoryStacked({
    kind: 'operation',
    rowWidthPx: headerWidth,
    accessoryWidthPx: actionsWidth,
  });
  const { verb, details, meta, purpose } = props.presentation;
  const line = [verb, ...details].join(' · ');
  const glyph = purpose ? (
    <WorkflowPurposeGlyph
      purpose={purpose}
      size={ICON_SIZE.xs}
      color={theme.colors.text.secondary}
    />
  ) : (
    <Icon
      name="tree-structure"
      size={ICON_SIZE.xs}
      color={theme.colors.text.secondary}
    />
  );
  // The outcome is the fact the row exists for: on a narrow row it wraps rather than ellipsizes, and the
  // trailing workflow/trigger fact is what gives way.
  const summary = (
    <>
      <View style={styles.glyph}>{glyph}</View>
      <Text
        numberOfLines={narrow || stacked ? 3 : 1}
        ellipsizeMode="tail"
        style={styles.line}
      >
        <Text style={styles.verb}>{verb}</Text>
        {details.map((part, index) => (
          <Text key={index} style={styles.detail}>{` · ${part}`}</Text>
        ))}
      </Text>
      {meta && !narrow && !stacked ? (
        <Text numberOfLines={1} ellipsizeMode="tail" style={styles.meta}>
          {meta}
        </Text>
      ) : null}
    </>
  );
  const { disclosure } = props;
  const openAction = open ? (
    <HappierPressable
      onPress={open}
      accessibilityRole="button"
      accessibilityLabel={`${t('workflows.run.open')}: ${verb}`}
      testID={`workflow-run-fold-open:${props.runId}`}
      style={({ pressed, focused }) => [
        styles.open,
        pressed
          ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle }
          : null,
        focusRingStyle({ focused, color: theme.colors.border.focus }),
      ]}
    >
      <Text style={styles.openLabel}>{t('workflows.run.open')}</Text>
    </HappierPressable>
  ) : null;
  // Measured only inline: that is the cluster's natural width the stacking rule compares.
  const actions = stacked ? null : (
    <View style={styles.actions} onLayout={onActionsLayout}>
      {props.actions}
      {openAction}
    </View>
  );
  return (
    <View
      style={[styles.header, stacked ? styles.headerStacked : null]}
      onLayout={onLayout}
    >
      <View style={styles.summaryRow}>
        {disclosure ? (
          <HappierPressable
            {...disclosure.headerProps}
            expanded={disclosure.expanded}
            accessibilityLabel={line}
            testID={`workflow-run-fold-toggle:${props.runId}`}
            style={({ pressed, focused }) => [
              styles.toggle,
              pressed
                ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle }
                : null,
              focusRingStyle({ focused, color: theme.colors.border.focus }),
            ]}
          >
            {summary}
          </HappierPressable>
        ) : (
          <View style={styles.toggle} testID={`workflow-run-fold:${props.runId}`}>
            {summary}
          </View>
        )}
        {stacked ? openAction : actions}
        {disclosure ? (
          // The caret ends the row, past the action. It repeats the row toggle for the pointer only; keyboard
          // and assistive technology reach the one toggle above.
          <View aria-hidden style={styles.caretHost}>
            <HappierPressable
              onPress={disclosure.headerProps.onPress}
              tabIndex={-1}
              style={styles.caret}
            >
              <ExpandableItemCaret expanded={disclosure.expanded} />
            </HappierPressable>
          </View>
        ) : null}
      </View>
      {stacked ? <View style={styles.actionsStacked}>{props.actions}</View> : null}
    </View>
  );
}

const FOLD_ROW_HEIGHT = 36;

const styles = StyleSheet.create((theme) => ({
  header: {
    minHeight: FOLD_ROW_HEIGHT,
    borderRadius: theme.borderRadius.lg,
    ...resolveThemeHairlineBorderStyle(theme.colors.border.surface),
    paddingLeft: theme.space.s10,
    paddingRight: theme.space.s8,
  },
  headerStacked: { paddingBottom: theme.space.s6 },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: FOLD_ROW_HEIGHT,
    gap: theme.space.s8,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    gap: theme.space.s8,
  },
  // Beneath the line, starting under it; wraps rather than overflowing the column.
  actionsStacked: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s8 },
  toggle: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    minHeight: FOLD_ROW_HEIGHT,
    paddingVertical: theme.space.s4,
    borderRadius: theme.borderRadius.md,
  },
  glyph: { flexShrink: 0 },
  line: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
    flexShrink: 1,
    minWidth: 0,
  },
  verb: {
    ...Typography.variant('meta', 'semiBold'),
    color: theme.colors.text.primary,
  },
  detail: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
  meta: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
    flexShrink: 1000,
    minWidth: 0,
    marginLeft: 'auto',
  },
  open: {
    minHeight: FOLD_ROW_HEIGHT,
    justifyContent: 'center',
    paddingHorizontal: theme.space.s8,
    borderRadius: theme.borderRadius.md,
  },
  openLabel: {
    ...Typography.variant('meta', 'medium'),
    color: theme.colors.text.primary,
  },
  caretHost: { flexShrink: 0 },
  caret: {
    minHeight: FOLD_ROW_HEIGHT,
    justifyContent: 'center',
    paddingHorizontal: theme.space.s2,
  },
}));
