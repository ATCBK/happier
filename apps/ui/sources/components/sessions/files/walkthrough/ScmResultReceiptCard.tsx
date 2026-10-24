import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { buildSessionDetailsHref } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { resolveSessionScmReviewComparisonLabel } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import {
  StructuredFindText,
  type StructuredFindTextBlock,
} from '@/components/sessions/transcript/structured/structuredFindText';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { SURFACE_CARD_RADIUS_PX } from '@/components/ui/cards/SurfaceCard';
import { Typography } from '@/constants/Typography';
import { scmReviewComparisonOfCaptured } from '@/sync/domains/scm/diffSummary/selection';
import type { ScmDiffSummaryPublishedResult } from '@/sync/domains/scm/diffSummary/publicationReceipt';
import { t } from '@/text';

function buildReceiptContent(receipt: ScmDiffSummaryPublishedResult) {
  const walkthroughChange = receipt.publication.outputs.find(
    (output) => output.kind === 'walkthrough',
  )?.change;
  const created = receipt.publication.outputs.every(
    (output) => output.change === 'created',
  );
  const walkthrough = walkthroughChange
    ? receipt.output.outputs?.walkthrough?.value
    : undefined;
  const comparison = scmReviewComparisonOfCaptured(receipt.output.comparison);
  const facts = [
    comparison ? resolveSessionScmReviewComparisonLabel(comparison) : null,
    t('scmComparison.fileCount', {
      count: receipt.output.comparison.inventory.files.length,
    }),
    walkthrough
      ? t('walkthrough.receipt.stopCount', { count: walkthrough.stops.length })
      : null,
  ].filter((fact): fact is string => Boolean(fact));
  return {
    comparison,
    isWalkthrough: Boolean(walkthroughChange),
    created: walkthroughChange ? walkthroughChange === 'created' : created,
    verb: walkthroughChange
      ? walkthroughChange === 'created'
        ? t('walkthrough.receipt.wrote')
        : t('walkthrough.receipt.updated')
      : created
        ? t('walkthrough.receipt.savedAnalysis')
        : t('walkthrough.receipt.updatedAnalysis'),
    facts: facts.join(' · '),
    title: walkthrough?.title ?? null,
  };
}

/** Find reads exactly the words the receipt shows. */
export function projectScmResultReceiptFindText(
  receipt: ScmDiffSummaryPublishedResult,
): readonly StructuredFindTextBlock[] {
  const content = buildReceiptContent(receipt);
  return [
    { id: 'structured-scm-receipt:verb', text: content.verb },
    { id: 'structured-scm-receipt:facts', text: content.facts },
    ...(content.title
      ? [{ id: 'structured-scm-receipt:title', text: content.title }]
      : []),
  ];
}

/**
 * The one transcript receipt for a saved change summary (lab WT3-D3): what the generator wrote or
 * updated, of which comparison, and the way into that saved reading. It replaces the Run's own summary
 * line, so the transcript never says the same thing twice. What was written reads as a quiet filled
 * strip with its title; an update is one inline line led by a check, between the question and the reply.
 */
export function ScmResultReceiptCard(
  props: Readonly<{
    receipt: ScmDiffSummaryPublishedResult;
    sessionId: string;
    serverId?: string | null;
    canNavigate: boolean;
  }>,
) {
  const { theme } = useUnistyles();
  const source = useSessionTranscriptSource();
  const navigate = source.navigate;
  const content = buildReceiptContent(props.receipt);
  const { comparison, isWalkthrough } = content;
  const { sessionId, serverId } = props;
  const open = React.useCallback(() => {
    if (!navigate || !comparison) return;
    navigate(
      buildSessionDetailsHref({
        sessionId,
        serverId,
        details: {
          kind: 'scmReview',
          comparison,
          view: isWalkthrough ? 'walkthrough' : 'files',
        },
      }),
    );
  }, [comparison, isWalkthrough, navigate, serverId, sessionId]);
  const canOpen = props.canNavigate && Boolean(navigate) && comparison !== null;
  const openLink = canOpen ? (
    <TextLinkButton
      testID="scm-result-receipt-open"
      size="meta"
      label={
        isWalkthrough
          ? t('walkthrough.receipt.open')
          : t('walkthrough.receipt.openChanges')
      }
      onPress={open}
    />
  ) : null;
  const headerLine = (
    <View style={styles.headerText}>
      <StructuredFindText
        blockId="structured-scm-receipt:verb"
        text={content.verb}
        style={content.created ? styles.verb : styles.updateVerb}
        numberOfLines={1}
      />
      <StructuredFindText
        blockId="structured-scm-receipt:facts"
        text={`· ${content.facts}`}
        style={styles.facts}
        numberOfLines={1}
      />
    </View>
  );
  if (!content.created) {
    return (
      <View testID="scm-result-receipt" style={styles.update}>
        <Icon
          name="check-circle"
          size={ICON_SIZE.sm}
          color={theme.colors.state.success.foreground}
        />
        {headerLine}
        {openLink}
      </View>
    );
  }
  return (
    <View testID="scm-result-receipt" style={styles.strip}>
      <View style={styles.header}>
        <Icon
          name="path"
          size={ICON_SIZE.xs}
          color={theme.colors.text.secondary}
        />
        {headerLine}
        {openLink}
      </View>
      {content.title ? (
        <StructuredFindText
          blockId="structured-scm-receipt:title"
          text={content.title}
          selectable
          style={styles.title}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  strip: {
    gap: theme.space.s6,
    paddingVertical: theme.space.s12,
    paddingHorizontal: theme.space.s16,
    borderRadius: SURFACE_CARD_RADIUS_PX,
    // The raised surface, flat: a quiet strip in flow (lab WT3-D3), never a bordered card.
    backgroundColor: theme.colors.surface.elevated,
  },
  update: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingVertical: theme.space.s4,
  },
  updateVerb: {
    flexShrink: 0,
    ...Typography.variant('meta', 'semiBold'),
    color: theme.colors.text.secondary,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: theme.space.s4,
  },
  verb: {
    flexShrink: 0,
    ...Typography.variant('label', 'semiBold'),
    color: theme.colors.text.primary,
  },
  facts: {
    flexShrink: 1,
    minWidth: 0,
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
    fontVariant: ['tabular-nums'],
  },
  title: {
    ...Typography.variant('body'),
    color: theme.colors.text.primary,
  },
}));
