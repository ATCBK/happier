import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { DiffViewerHunks } from '@/components/ui/code/diff/diffViewerTypes';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ReviewBar } from '@/components/workspaces/scm/review/hunkReview/ReviewBar';
import { ReviewStrip } from '@/components/workspaces/scm/review/hunkReview/ReviewStrip';
import { useReviewKeyboard } from '@/components/workspaces/scm/review/hunkReview/useReviewKeyboard';
import { useDeviceType } from '@/utils/platform/responsive';
import { resolveFileViewerKind } from '@/scm/utils/filePresentation';
import { ImageCompare } from '@/components/workspaces/scm/review/imageCompare/ImageCompare';
import { useImageCompare } from '@/components/workspaces/scm/review/imageCompare/useImageCompare';
import { useMediaStage } from '@/components/ui/media/stage/useMediaStage';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { ReviewUnit } from '@happier-dev/protocol/scm/comparisonOccurrences';
import { t } from '@/text';
import {
  useFileChangesReview,
  type FileChangesReview,
  type FileChangesReviewParams,
  type FileChangesScopeKind,
} from './useFileChangesReview';

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

/**
 * The review strip / Changes scope row for the File page notice slot (lab ade-shell RV2, CK1).
 * Phones keep the scope only; the review bar carries the counter and actions.
 */
export function FileChangesStrip(
  props: Readonly<{ review: FileChangesReview }>,
) {
  const { review } = props;
  const phone = useDeviceType() === 'phone';
  const strip = review.controller.strip;
  const scope = {
    tabs: review.scopeTabs,
    active: review.scopeKind,
    onSelect: review.selectScope,
  };
  const complete =
    strip.fileComplete && review.status === 'ready'
      ? {
          left: strip.remaining,
          nextFileName: strip.nextFile ? baseName(strip.nextFile) : null,
          onNextFile: strip.nextFile ? review.controller.nextFile : undefined,
        }
      : null;
  return (
    <ReviewStrip<FileChangesScopeKind>
      testID="file-changes-strip"
      compact={phone}
      scope={scope}
      current={strip.currentOrdinal}
      total={review.status === 'ready' ? strip.total : 0}
      onPrevious={strip.total > 0 ? review.controller.previous : undefined}
      onNext={strip.total > 0 ? review.controller.next : undefined}
      onKeepAll={strip.canKeepAll ? review.controller.keepAll : undefined}
      complete={complete}
    />
  );
}

export type FileChangesDiffSurface = Readonly<{
  unifiedDiff: string;
  hunks: DiffViewerHunks;
  reviewUnits: readonly ReviewUnit[];
  scrollToLineId?: string;
}>;

/**
 * The Changes body: the scope's diff with per-change rows, its loading / empty / error states and,
 * on phones, the review bar. The page supplies the diff surface it already owns (find, comments,
 * line selection) through `children`; this region only decides what that surface shows.
 */
export function FileChangesBody(
  props: Readonly<{
    review: FileChangesReview;
    /** Front-most review surface: the one that answers J/K/R/D. */
    keyboardActive: boolean;
    containsFocus?: () => boolean;
    /** Image and SVG files compare as images instead of the text diff. */
    image?: Readonly<{ scope: WorkspaceScopeBase; filePath: string; liveChangeKind?: string | null }> | null;
    children: (surface: FileChangesDiffSurface) => React.ReactNode;
  }>,
) {
  const { review } = props;
  const phone = useDeviceType() === 'phone';
  useReviewKeyboard(review.keyboard, {
    active: props.keyboardActive && review.status === 'ready',
    containsFocus: props.containsFocus,
  });
  const strip = review.controller.strip;
  const viewer = props.image ? resolveFileViewerKind({ path: props.image.filePath }) : null;
  if (props.image && viewer && (viewer.kind === 'image' || viewer.kind === 'svg') && review.status !== 'loading') {
    return (
      <View style={styles.body}>
        <FileChangesImageCompare review={review} scope={props.image.scope} filePath={props.image.filePath}
          liveChangeKind={props.image.liveChangeKind} />
        {viewer.kind === 'svg' && review.status === 'ready' && review.unifiedDiff ? props.children({
          unifiedDiff: review.unifiedDiff, hunks: review.hunks, reviewUnits: review.reviewUnits, scrollToLineId: review.scrollToLineId,
        }) : null}
      </View>
    );
  }

  if (review.status === 'loading') {
    return (
      <SurfaceStateCard
        testID="file-changes-loading"
        kind="loading"
        size="line"
        title={t('common.loading')}
      />
    );
  }
  if (review.status === 'error') {
    return (
      <SurfaceStateCard
        testID="file-changes-error"
        kind="error"
        size="line"
        title={review.error ?? t('hunkReview.noticeUnavailable')}
        action={{ label: t('common.retry'), onPress: review.refresh }}
      />
    );
  }
  if (review.status === 'empty' || !review.unifiedDiff) {
    const turnScope =
      review.scopeKind === 'turn' &&
      review.scopeTabs.some((tab) => tab.id === 'session');
    return (
      <SurfaceStateCard
        testID="file-changes-empty"
        kind="empty"
        size="line"
        title={
          turnScope ? t('hunkReview.noTurnChanges') : t('hunkReview.noChanges')
        }
        {...(turnScope
          ? {
              action: {
                label: t('hunkReview.showSession'),
                onPress: () => review.selectScope('session'),
              },
            }
          : {})}
      />
    );
  }
  return (
    <View style={styles.body}>
      {props.children({
        unifiedDiff: review.unifiedDiff,
        hunks: review.hunks,
        reviewUnits: review.reviewUnits,
        scrollToLineId: review.scrollToLineId,
      })}
      {phone && strip.total > 0 ? (
        <ReviewBar
          testID="file-review-bar"
          current={strip.currentOrdinal}
          total={strip.total}
          onPrevious={review.controller.previous}
          onNext={review.controller.next}
          onKeep={review.controller.keepCurrent}
          onDiscard={review.controller.discardCurrent}
          discardDisabledReason={review.discardDisabledReason}
          complete={
            strip.fileComplete
              ? {
                  nextFileName: strip.nextFile
                    ? baseName(strip.nextFile)
                    : null,
                  onNextFile: strip.nextFile
                    ? review.controller.nextFile
                    : undefined,
                }
              : null
          }
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
    minHeight: 0,
  },
});

/**
 * The whole Changes region as the File page places it in its body slot: the review strip under the
 * page's notices, then the scope's diff (supplied by the page through `children`) and, on phones,
 * the review bar. Restore / Discard-all menu items are handed up through `onMenuChanges`.
 */
export function FileChangesSection(props: FileChangesReviewParams & Readonly<{
    keyboardActive: boolean;
    containsFocus?: () => boolean;
    onMenuChanges?: (changes: FileChangesReview['menuChanges'] | null) => void;
    liveChangeKind?: string | null;
    children: (surface: FileChangesDiffSurface) => React.ReactNode;
}>) {
    const { keyboardActive, containsFocus, onMenuChanges, children, liveChangeKind, ...params } = props;
    const review = useFileChangesReview(params);
    const { theme } = useUnistyles();
    // The page's menu receives stable runners keyed by which items exist; each run reads the latest owner.
    const latestMenu = React.useRef(review.menuChanges);
    latestMenu.current = review.menuChanges;
    const hasDiscardAll = Boolean(review.menuChanges.discardAll);
    const hasRestore = Boolean(review.menuChanges.restoreBeforeTurn);
    const restoreTitle = review.menuChanges.restoreBeforeTurnTitle;
    const menuChanges = React.useMemo(() => ({
        ...(hasDiscardAll ? { discardAll: () => latestMenu.current.discardAll?.() } : {}),
        ...(hasRestore ? { restoreBeforeTurn: () => latestMenu.current.restoreBeforeTurn?.() } : {}),
        ...(restoreTitle ? { restoreBeforeTurnTitle: restoreTitle } : {}),
    }), [hasDiscardAll, hasRestore, restoreTitle]);
    React.useEffect(() => {
        onMenuChanges?.(menuChanges);
    }, [onMenuChanges, menuChanges]);
    React.useEffect(() => () => onMenuChanges?.(null), [onMenuChanges]);
    return (
        <View testID="file-changes-section" style={sectionStyles.section}>
            <View style={[sectionStyles.stripRow, { borderBottomColor: theme.colors.border.subtle }]}>
                <FileChangesStrip review={review} />
            </View>
            <FileChangesBody review={review} keyboardActive={keyboardActive} containsFocus={containsFocus}
        image={{ scope: params.scope, filePath: params.filePath, liveChangeKind }}>
                {children}
            </FileChangesBody>
        </View>
    );
}

const sectionStyles = StyleSheet.create({
    section: {
        flex: 1,
        minHeight: 0,
    },
    stripRow: {
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
});


/** Changes of an image or SVG file: the visual compare (files lab RV1), bytes from the pinned revisions. */
function FileChangesImageCompare(props: Readonly<{ review: FileChangesReview; scope: WorkspaceScopeBase; filePath: string;
    liveChangeKind?: string | null; }>) {
    const { review } = props;
    const viewer = resolveFileViewerKind({ path: props.filePath });
    const captured = review.capturedFile && review.comparison
        ? { kind: 'captured' as const, file: review.capturedFile, comparisonId: review.comparison.id } : null;
    const compare = useImageCompare({
        enabled: review.live || captured !== null,
        scope: props.scope,
        filePath: props.filePath,
        source: captured ?? { kind: 'workingTree', changeKind: props.liveChangeKind ?? 'modified', area: 'both' },
    });
    const stage = useMediaStage();
    const openStage = (side: 'before' | 'after') => {
      const index = side === 'before' ? compare.beforeGalleryIndex : compare.afterGalleryIndex;
      if (index !== null) stage.open(compare.gallery, index);
    };
    const turn = review.turnNumber !== null ? t('hunkReview.turn', { turn: review.turnNumber }) : null;
    return (
        <ImageCompare
            testID="file-changes-image-compare"
            filePath={props.filePath}
            kind={viewer.kind === 'svg' ? 'svg' : 'image'}
            alphaCapable={viewer.alphaCapable}
            before={compare.before}
            after={compare.after}
            beforePreviewInput={compare.beforePreviewInput}
            afterPreviewInput={compare.afterPreviewInput}
            onOpenStage={compare.gallery.length > 0 ? openStage : undefined}
            beforeLabel={review.live ? 'HEAD' : review.scopeKind === 'turn' && turn ? turn : undefined}
                    />
    );
}
