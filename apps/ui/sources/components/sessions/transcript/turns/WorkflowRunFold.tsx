import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { useWorkflowsAvailability } from '@/components/workflows/gating/workflowsAvailability';
import { WorkflowRunFoldHeader } from '@/components/workflows/presentation/WorkflowRunFoldHeader';
import { describeWorkflowTriggerRunFold } from '@/components/workflows/presentation/workflowTriggerRunFoldPresentation';
import { isTerminalWorkflowRunState } from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { useSessionManagedWorkflowRunFlow } from '@/components/workflows/run/useContextManagedWorkflowRuns';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { workflowRunDetailActions } from '@/sync/domains/workflows/workflowRunDetailActions';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { publishOpenedWorkflowRunDetail } from '@/sync/engine/workflows/refreshWorkflowRun';
import {
  useActiveServerAccountScope,
  useWorkflowRun,
} from '@/sync/store/hooks';
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

  const source = useSessionTranscriptSource();
  const runId = props.run.runId;
  const open = React.useMemo(() => source.navigate === null ? null : () => {
    navigateWithBlurOnWeb(() => source.navigate?.(createWorkflowRunRoute(runId)));
  }, [runId, source.navigate]);
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
            onOpen={open}
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
              onOpen={open}
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

const styles = StyleSheet.create((theme) => ({
  // The row sits in the transcript column exactly like a message: centered, at most the column's width.
  outer: { width: '100%', alignSelf: 'center' },
  container: {
    width: '100%',
    paddingHorizontal: theme.space.s16,
    paddingBottom: theme.space.s12,
  },
  body: { paddingTop: theme.space.s8 },
}));
