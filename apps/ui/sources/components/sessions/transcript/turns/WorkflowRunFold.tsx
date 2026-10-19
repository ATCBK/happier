import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HappierPressable,
  HAPPIER_PRESS_FEEDBACK_V1,
  isHappierPageRowNarrow,
  type HappierDisclosureHeaderState,
} from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import {
  ExpandableItem,
  ExpandableItemCaret,
} from '@/components/ui/lists/ExpandableItem';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { resolveThemeHairlineBorderStyle } from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';
import { useWorkflowsAvailability } from '@/components/workflows/gating/workflowsAvailability';
import { WorkflowPurposeGlyph } from '@/components/workflows/presentation/WorkflowPurposeGlyph';
import { describeWorkflowTriggerRunFold } from '@/components/workflows/presentation/workflowTriggerRunFoldPresentation';
import { isTerminalWorkflowRunState } from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { useSessionManagedWorkflowRunFlow } from '@/components/workflows/run/useContextManagedWorkflowRuns';
import { Typography } from '@/constants/Typography';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { workflowRunDetailActions } from '@/sync/domains/workflows/workflowRunDetailActions';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { publishOpenedWorkflowRunDetail } from '@/sync/engine/workflows/refreshWorkflowRun';
import {
  useActiveServerAccountScope,
  useWorkflowRun,
} from '@/sync/store/hooks';
import { t } from '@/text';
import { navigateWithBlurOnWeb } from '@/utils/platform/navigateWithBlurOnWeb';

import { useTranscriptRowLayoutMutation } from '../measurement/TranscriptRowLayoutMutationContext';
import { useSessionTranscriptSource } from '../source/SessionTranscriptSourceContext';
import type { WorkflowOriginRunFold } from '../turnGrouping/workflowTranscriptTurns';

type RunRow = ReturnType<typeof useWorkflowRun>;

/**
 * The exact Run behind a fold, read through the one Account-scoped Run row owner.
 *
 * The accepted source, inputs and recorded result are frozen once the Run settles, so a mounted fold
 * opens the Run once and once more when its change-stream summary turns terminal; the store keeps the
 * body for every other surface. Static, public or another Home's transcripts read nothing private.
 */
function useTriggerRunRow(
  runId: string,
  serverId: string | null | undefined,
): RunRow {
  const source = useSessionTranscriptSource();
  const activeScope = useActiveServerAccountScope();
  const workflowsAvailable = useWorkflowsAvailability().available;
  const readable =
    source.kind === 'app' &&
    workflowsAvailable &&
    activeScope !== null &&
    typeof serverId === 'string' &&
    areServerProfileIdentifiersEquivalent(activeScope.serverId, serverId);
  const row = useWorkflowRun(readable ? runId : null);
  const summaryTerminal = row?.summary
    ? isTerminalWorkflowRunState(row.summary.state)
    : false;
  const detailCurrent =
    row?.detail !== undefined &&
    (!summaryTerminal || isTerminalWorkflowRunState(row.detail.run.state));
  React.useEffect(() => {
    if (!readable || detailCurrent) return;
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (lifetime === null) return;
    const controller = new AbortController();
    const retirement = lifetime.onRetire(() => controller.abort());
    void workflowRunDetailActions.getRun(runId, controller.signal).then(
      (detail) => {
        if (controller.signal.aborted || !lifetime.isCurrent()) return;
        publishOpenedWorkflowRunDetail(detail, lifetime.scope);
      },
      () => undefined,
    );
    return () => {
      retirement.dispose();
      controller.abort();
    };
  }, [detailCurrent, readable, runId, summaryTerminal]);
  return readable ? row : null;
}

/** Keep going's second opinion settles a Notify me node only when it disagreed (08 §3.1). */
const SecondOpinionOutcome = React.memo(function SecondOpinionOutcome(
  props: Readonly<{
    runId: string;
    serverId: string | null;
    children: (disagreed: boolean) => React.ReactNode;
  }>,
) {
  const flow = useSessionManagedWorkflowRunFlow(props.runId, props.serverId);
  const disagreed =
    flow?.runStates
      .get('notify')
      ?.some((state) => state.lifecycle === 'completed') === true;
  return <>{props.children(disagreed)}</>;
});

export const WorkflowRunFold = React.memo(function WorkflowRunFold(
  props: Readonly<{
    turnId: string;
    run: WorkflowOriginRunFold;
    serverId?: string | null;
    children: React.ReactNode;
    reducedMotion?: boolean;
  }>,
) {
  const [expanded, setExpanded] = React.useState(false);
  const notifyLayoutMutation = useTranscriptRowLayoutMutation();
  const maxWidthStyle = useLayoutMaxWidthStyle();
  const row = useTriggerRunRow(props.run.runId, props.serverId);
  const changeExpanded = React.useCallback(
    (next: boolean) => {
      notifyLayoutMutation({
        reason: next ? 'expand' : 'collapse',
        sourceId: props.turnId,
      });
      setExpanded(next);
    },
    [notifyLayoutMutation, props.turnId],
  );

  const detail = row?.detail;
  const acceptedSource = detail?.acceptedContext.source;
  const catalogRef =
    acceptedSource?.kind === 'catalog' ? acceptedSource.ref : null;
  const inputs = detail?.acceptedContext.inputs as
    | Readonly<Record<string, unknown>>
    | undefined;
  const summary = row?.summary ?? null;
  const probeSecondOpinion =
    catalogRef === 'builtin:keep-going' &&
    inputs?.secondOpinion === true &&
    summary?.state === 'succeeded';
  const renderHeader = (secondOpinionDisagreed: boolean) => {
    const presentation = describeWorkflowTriggerRunFold({
      catalogRef,
      workflowTitle:
        row?.metadata?.kind === 'available' ? row.metadata.value.title : null,
      turnCount: props.run.turnCount,
      run: summary
        ? {
            state: summary.state,
            workflowCustodyState: summary.workflowCustodyState,
          }
        : null,
      result:
        detail && isTerminalWorkflowRunState(detail.run.state)
          ? detail.result
          : undefined,
      inputs: inputs ?? null,
      secondOpinionDisagreed,
      trigger:
        summary?.origin.kind === 'automation' ? summary.origin.cause : null,
    });
    // A run that wrote no turn here has nothing to expand: the row only names its outcome and opens the run.
    if (props.run.turnCount === 0) {
      return (
        <View style={styles.container}>
          <WorkflowRunFoldHeader
            runId={props.run.runId}
            disclosure={null}
            presentation={presentation}
          />
        </View>
      );
    }
    return (
      <View style={styles.container}>
        <ExpandableItem
          expanded={expanded}
          onExpandedChange={changeExpanded}
          showDivider={false}
          reducedMotion={props.reducedMotion}
          testID={`workflow-run-fold:${props.run.runId}`}
          header={({ expanded: isExpanded, headerProps }) => (
            <WorkflowRunFoldHeader
              runId={props.run.runId}
              disclosure={{ expanded: isExpanded, headerProps }}
              presentation={presentation}
            />
          )}
        >
          <View style={styles.body}>{props.children}</View>
        </ExpandableItem>
      </View>
    );
  };
  return (
    <View style={[styles.outer, maxWidthStyle]}>
      {probeSecondOpinion ? (
        <SecondOpinionOutcome
          runId={props.run.runId}
          serverId={props.serverId ?? null}
        >
          {renderHeader}
        </SecondOpinionOutcome>
      ) : (
        renderHeader(false)
      )}
    </View>
  );
});

function WorkflowRunFoldHeader(
  props: Readonly<{
    runId: string;
    /** Absent for a run with nothing to expand. */
    disclosure: Readonly<{
      expanded: boolean;
      headerProps: HappierDisclosureHeaderState['headerProps'];
    }> | null;
    presentation: ReturnType<typeof describeWorkflowTriggerRunFold>;
  }>,
) {
  const { theme } = useUnistyles();
  const source = useSessionTranscriptSource();
  const [narrow, setNarrow] = React.useState(false);
  const onLayout = React.useCallback((event: LayoutChangeEvent) => {
    setNarrow(isHappierPageRowNarrow(event.nativeEvent.layout.width));
  }, []);
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
  const open =
    source.navigate === null
      ? null
      : () => {
          navigateWithBlurOnWeb(() =>
            source.navigate?.(createWorkflowRunRoute(props.runId)),
          );
        };
  // The outcome is the fact the row exists for: on a narrow row it wraps rather than ellipsizes, and the
  // trailing workflow/trigger fact is what gives way.
  const summary = (
    <>
      <View style={styles.glyph}>{glyph}</View>
      <Text
        numberOfLines={narrow ? 3 : 1}
        ellipsizeMode="tail"
        style={styles.line}
      >
        <Text style={styles.verb}>{verb}</Text>
        {details.map((part, index) => (
          <Text key={index} style={styles.detail}>{` · ${part}`}</Text>
        ))}
      </Text>
      {meta && !narrow ? (
        <Text numberOfLines={1} ellipsizeMode="tail" style={styles.meta}>
          {meta}
        </Text>
      ) : null}
    </>
  );
  const { disclosure } = props;
  return (
    <View style={styles.header} onLayout={onLayout}>
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
      {open ? (
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
      ) : null}
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
  );
}

const FOLD_ROW_HEIGHT = 36;

const styles = StyleSheet.create((theme) => ({
  // The row sits in the transcript column exactly like a message: centered, at most the column's width.
  outer: { width: '100%', alignSelf: 'center' },
  container: {
    width: '100%',
    paddingHorizontal: theme.space.s16,
    paddingBottom: theme.space.s12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: FOLD_ROW_HEIGHT,
    borderRadius: theme.borderRadius.lg,
    ...resolveThemeHairlineBorderStyle(theme.colors.border.surface),
    paddingLeft: theme.space.s10,
    paddingRight: theme.space.s8,
    gap: theme.space.s8,
  },
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
  body: { paddingTop: theme.space.s8 },
}));
