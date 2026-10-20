import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
  MarkdownView,
  type MarkdownSelectionAction,
} from '@/components/markdown/MarkdownView';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';

import type { ArtifactNativeSelectionRequest } from './ArtifactPassageSelection';

/**
 * Where a commented (marked) block's words are chosen on iOS/Android: the captured block, drawn by the
 * same Markdown owner and its native selection menu, so the person can pick the exact words to comment
 * on. The menu's own text snapshot goes to the Doc's completion unchanged; a selection the Doc can no
 * longer place says so and stays open — never a whole-block comment.
 */
export function ArtifactPassageRefineContent(
  props: Readonly<{
    request: ArtifactNativeSelectionRequest;
    onClose: () => void;
  }>,
): React.ReactElement {
  const { request, onClose } = props;
  const [failed, setFailed] = React.useState(false);
  const actions = React.useMemo<readonly MarkdownSelectionAction[]>(
    () => [
      {
        label: t('artifacts.browser.passage.comment'),
        onPress: (_block, selection) => {
          if (selection && request.complete(selection)) {
            onClose();
            return;
          }
          setFailed(true);
        },
      },
    ],
    [onClose, request],
  );
  return (
    <View style={styles.body}>
      <MarkdownView
        testID="artifact:passage-refine.body"
        markdown={request.markdown}
        selectionActions={actions}
      />
      {failed ? (
        <SurfaceStateCard
          testID="artifact:passage-refine.failed"
          kind="error"
          size="line"
          title={t('artifacts.browser.passage.refineFailed')}
          accessibilitySemantics="alert"
        />
      ) : null}
    </View>
  );
}

function ArtifactPassageRefineModal(
  props: CustomModalInjectedProps &
    Readonly<{ request: ArtifactNativeSelectionRequest }>,
): React.ReactElement {
  return (
    <ArtifactPassageRefineContent
      request={props.request}
      onClose={props.onClose}
    />
  );
}

/** The Doc body's host for a marked block's Comment (`ArtifactPassageSelection.onRequestNativeSelection`). */
export function showArtifactPassageRefineSheet(
  request: ArtifactNativeSelectionRequest,
): void {
  Modal.show({
    component: ArtifactPassageRefineModal,
    props: { request },
    chrome: {
      kind: 'card',
      phonePresentation: 'sheet',
      testID: 'artifact:passage-refine',
      title: t('artifacts.browser.passage.comment'),
      subtitle: t('artifacts.browser.passage.refineHint'),
      scrollHost: 'bounded',
      bodyScroll: 'auto',
      dimensions: {
        width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide,
        maxHeightRatio: 0.8,
        size: 'md',
      },
    },
    closeOnBackdrop: true,
  });
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.space.s12,
    paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx,
    paddingBottom: theme.space.s24,
  },
}));
