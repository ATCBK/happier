import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter, type Href } from 'expo-router';
import type {
  WorkflowRunPrivateMetadataV1,
  WorkflowRunStartResultV1,
} from '@happier-dev/protocol/workflows/actionsV1';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';

import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { WorkflowRunFoldHeader } from '@/components/workflows/presentation/WorkflowRunFoldHeader';
import {
  formatWorkflowRunDisplayName,
  resolveWorkflowRunDisplayName,
} from '@/components/workflows/presentation/workflowRunDisplayName';
import { useWorkflowInlineRunControls } from '@/components/workflows/run/useWorkflowInlineRunControls';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { isTerminalWorkflowRunState } from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { t } from '@/text';

/**
 * A Pattern run started from this Discussion, under the message that started it (lab T4 FD): the shared
 * Run band names it and its state, Open goes to the full Run, and Another round appears only when the Run
 * offers it. Replies arrive as ordinary attributed messages; this row never repeats them.
 */
export const DiscussionWorkflowRunRow = React.memo(
  function DiscussionWorkflowRunRow(
    props: Readonly<{
      run: WorkflowRunSummaryV1;
      metadata: WorkflowRunPrivateMetadataV1 | null | undefined;
      supportsAnotherRound: boolean | undefined;
      canEdit: boolean;
      accountLifetime: ServerAccountScopeLifetime;
      /** The new round stays here: the list re-reads and shows it under its message. */
      onStarted: (result: WorkflowRunStartResultV1) => void;
      /** The committed replies this Run published here, in thread order. */
      publishedMessageIds: readonly string[];
      /** Save as pattern from this finished Run's replies; the Discussion's one capture controller. */
      onSaveAsPattern: (messageIds: readonly string[]) => void;
    }>,
  ) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const column = useLayoutMaxWidthStyle();
    const serverId = props.accountLifetime.scope.serverId;
    const openRun = React.useCallback(
      (runId: string) => {
        router.push(createWorkflowRunRoute(runId, serverId) as Href);
      },
      [router, serverId],
    );
    const controls = useWorkflowInlineRunControls({
      run: props.run,
      definition: null,
      acceptedContext: null,
      supportsAnotherRound: props.supportsAnotherRound,
      accountLifetime: props.accountLifetime,
      canEdit: props.canEdit,
      onStarted: props.onStarted,
    });
    const progress = controls.progress;
    const presentation = React.useMemo(
      () => ({
        verb: formatWorkflowRunDisplayName(
          resolveWorkflowRunDisplayName(props.metadata),
        ),
        // The lifecycle word already says "Needs you" while the Run waits on the person.
        details: [controls.lifecycle.label, ...(progress ? [progress] : [])],
        meta: null,
        purpose: null,
      }),
      [controls.lifecycle.label, progress, props.metadata],
    );
    const pending =
      controls.start.pendingRunId !== null &&
      controls.start.isPending(controls.start.pendingRunId);
    const anotherRound = controls.anotherRound;
    const runId = props.run.id;
    const open = React.useCallback(() => openRun(runId), [openRun, runId]);
    const { publishedMessageIds, onSaveAsPattern } = props;
    const savePattern = React.useCallback(
      () => onSaveAsPattern(publishedMessageIds),
      [onSaveAsPattern, publishedMessageIds],
    );
    const canSavePattern =
      isTerminalWorkflowRunState(props.run.state) &&
      publishedMessageIds.length > 0;
    return (
      <View
        style={[styles.outer, column]}
        testID={`discussion-workflow-run:${runId}`}
      >
        <View style={styles.container}>
          <WorkflowRunFoldHeader
            runId={runId}
            disclosure={null}
            presentation={presentation}
            onOpen={open}
            actions={
              <>
                {canSavePattern ? (
                  <ToolbarButton
                    testID={`discussion-workflow-run-save-pattern:${runId}`}
                    label={t('workflows.start.capture.title')}
                    icon={
                      <Icon
                        name="bookmark"
                        size={ICON_SIZE.xs}
                        color={theme.colors.text.secondary}
                      />
                    }
                    onPress={savePattern}
                  />
                ) : null}
                {anotherRound ? (
                <ToolbarButton
                  testID={`discussion-workflow-run-another-round:${runId}`}
                  label={t('workflows.start.anotherRound')}
                  icon={
                    <Icon
                      name="arrows-clockwise"
                      size={ICON_SIZE.xs}
                      color={theme.colors.text.secondary}
                    />
                  }
                  disabled={pending}
                  busy={pending}
                  onPress={() => void anotherRound()}
                />
                ) : null}
              </>
            }
          />
          {controls.start.refusal ? (
            <SurfaceStateCard
              testID={`discussion-workflow-run-refusal:${runId}`}
              size="line"
              kind="error"
              accessibilitySemantics="status"
              title={controls.start.refusal.message}
            />
          ) : null}
        </View>
      </View>
    );
  },
);

const styles = StyleSheet.create((theme) => ({
  // As the Session fold: centered in the thread column, at most its width.
  outer: { width: '100%', alignSelf: 'center' },
  container: {
    width: '100%',
    paddingHorizontal: theme.space.s16,
    paddingBottom: theme.space.s12,
    gap: theme.space.s4,
  },
}));
