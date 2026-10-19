import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { readPromptDocInLibrary } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';

import { ToolDiffView } from '@/components/tools/shell/presentation/ToolDiffView';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { withUiPromptLibraryArtifactReader } from '@/sync/ops/promptLibrary/promptLibraryArtifactStore';
import { t } from '@/text';
import type { PromptDocUpdateApproval } from './promptDocApprovalModel';
export { readPromptDocUpdateApproval, type PromptDocUpdateApproval } from './promptDocApprovalModel';

type CurrentDocument =
  | Readonly<{ status: 'loading' }>
  | Readonly<{
      status: 'ready';
      markdown: string;
      revision: Readonly<{ headerVersion: number; bodyVersion: number }>;
    }>
  | Readonly<{ status: 'unavailable' }>;

/**
 * The Agent's proposed instructions edit as a diff against the document as it is now (plan 61, lab
 * `b-work P`): context lines quiet, the change marked. When the document changed after the edit was
 * reviewed, the card says so — approving would be refused by the reviewed-revision check, never
 * silently rebased. When it applies is said once beneath.
 */
export const PromptDocApprovalDiff = React.memo(function PromptDocApprovalDiff(
  props: Readonly<{
    request: PromptDocUpdateApproval;
    serverId: string | null;
    sessionId?: string | null;
    testID?: string;
  }>,
): React.ReactElement {
  const styles = stylesheet;
  const { artifactId } = props.request;
  const [current, setCurrent] = React.useState<CurrentDocument>({
    status: 'loading',
  });
  React.useEffect(() => {
    const controller = new AbortController();
    setCurrent({ status: 'loading' });
    void (async () => {
      try {
        const result = await withUiPromptLibraryArtifactReader(
          (reader) =>
            readPromptDocInLibrary({
              artifactId,
              store: {
                read: () =>
                  reader.readArtifact({
                    kind: 'doc',
                    artifactId,
                    ...(props.serverId ? { serverId: props.serverId } : {}),
                  }),
              },
              signal: controller.signal,
            }),
          { serverId: props.serverId, signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setCurrent(
          result.ok
            ? {
                status: 'ready',
                markdown: result.markdown,
                revision: result.revision,
              }
            : { status: 'unavailable' },
        );
      } catch {
        if (!controller.signal.aborted) setCurrent({ status: 'unavailable' });
      }
    })();
    return () => controller.abort();
  }, [artifactId, props.serverId]);
  const testID = props.testID ?? 'prompt-doc-approval-diff';
  const reviewed = props.request.expectedRevision;
  const changedSinceReview =
    current.status === 'ready' &&
    reviewed !== null &&
    (reviewed.headerVersion !== current.revision.headerVersion ||
      reviewed.bodyVersion !== current.revision.bodyVersion);
  return (
    <View testID={testID} style={styles.container}>
      {changedSinceReview ? (
        <Text testID={`${testID}.conflict`} style={styles.conflict}>
          {t('sessionInstructions.saveConflict')}
        </Text>
      ) : null}
      {current.status === 'ready' ? (
        <ToolDiffView
          sessionId={props.sessionId ?? null}
          serverId={props.serverId}
          oldText={current.markdown}
          newText={props.request.markdown}
        />
      ) : current.status === 'loading' ? (
        <Text style={styles.quiet}>{t('sessionInstructions.loading')}</Text>
      ) : (
        <ToolDiffView
          sessionId={props.sessionId ?? null}
          serverId={props.serverId}
          oldText=""
          newText={props.request.markdown}
        />
      )}
      <Text style={styles.quiet}>{t('sessionInstructions.nextBoundary')}</Text>
    </View>
  );
});

const stylesheet = StyleSheet.create((theme) => ({
  container: { gap: theme.space.s8 },
  conflict: {
    ...Typography.variant('meta'),
    color: theme.colors.state.warning.foreground,
  },
  quiet: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
}));
