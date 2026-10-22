import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolCall } from '@happier-dev/session-core/messages';
import type { Metadata } from '@happier-dev/session-core/state';

import { PageHeader } from '@/components/ui/layout/PageHeader';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { buildToolHeaderModel } from './buildToolHeaderModel';
import {
  resolveToolActionFailure,
  toolActionOutcomeLabel,
} from './resolveToolActionFailure';
import {
  resolveToolStatusIndicatorKind,
  type ToolStatusIndicatorKind,
} from './resolveToolStatusIndicatorKind';
import { ToolOutcomeStatus } from './ToolOutcomeStatus';
import { ToolStatusIndicator } from './ToolStatusIndicator';

function outcomeWord(kind: ToolStatusIndicatorKind): string | null {
  switch (kind) {
    case 'completed':
      return t('toolView.outcome.completed');
    case 'running':
      return t('toolView.outcome.running');
    case 'permission_pending':
      return t('toolView.outcome.waiting');
    case 'permission_blocked':
      return t('toolView.outcome.blocked');
    case 'error':
      return t('toolView.actionOutcome.failed');
    default:
      return null;
  }
}

/**
 * The tool-details page's identity: the call's title (the Action it ran, the command, the file), its one
 * line, and its outcome in the transcript row's vocabulary — the same glyph, and a refusal or failure as
 * the row's own outcome mark. One owner for every tool kind that opens this page.
 */
export const ToolDetailsPageHeader = React.memo(function ToolDetailsPageHeader(
  props: Readonly<{
    tool: ToolCall;
    metadata: Metadata | null;
  }>,
) {
  const model = React.useMemo(
    () =>
      buildToolHeaderModel({
        tool: props.tool,
        metadata: props.metadata,
        iconSize: 18,
        iconColorPrimary: '',
        iconColorSecondary: '',
      }),
    [props.metadata, props.tool],
  );
  const tool = model.toolForRendering;
  const kind = resolveToolStatusIndicatorKind(tool);
  const failure = kind === 'error' ? resolveToolActionFailure(tool) : null;
  const word = failure
    ? toolActionOutcomeLabel(failure.outcome)
    : outcomeWord(kind);
  const outcome =
    word === null ? undefined : failure || kind === 'error' ? (
      // The row's outcome mark sits at the line's start here, not at a row's trailing edge.
      <View style={styles.outcome}>
        <ToolOutcomeStatus
          testID="tool-details-outcome"
          label={word}
          glyph={
            failure?.outcome === 'refused' ? 'minus-circle' : 'warning-circle'
          }
          tone={failure?.outcome === 'refused' ? 'quiet' : 'danger'}
        />
      </View>
    ) : (
      <View
        testID="tool-details-outcome"
        accessible
        accessibilityLabel={word}
        style={styles.outcome}
      >
        <ToolStatusIndicator tool={tool} />
        <Text style={styles.outcomeText} numberOfLines={1}>
          {word}
        </Text>
      </View>
    );
  return (
    <PageHeader
      testID="tool-details-header"
      alwaysShowBack
      title={model.title}
      description={model.subtitle ?? undefined}
      details={outcome}
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  outcome: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    minWidth: 0,
  },
  outcomeText: {
    ...Typography.variant('meta', 'semiBold'),
    color: theme.colors.text.secondary,
    flexShrink: 1,
  },
}));
