import * as React from 'react';
import { View } from 'react-native';
import type { ScmFileAtRevisionRequest } from '@happier-dev/protocol/scm';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { StatusPill } from '@/components/ui/status/StatusPill';
import { ImageWell, type ImageWellInfo } from '@/components/ui/media/ImageWell';
import { useMediaStage } from '@/components/ui/media/stage/useMediaStage';
import type { MediaStageItem } from '@/components/ui/media/stage/mediaStageItems';
import { useFileAtRevisionPreview } from '@/components/ui/media/useFileAtRevisionPreview';
import type { UseFilePreviewSourceInput } from '@/components/ui/media/useFilePreviewSource';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { FileViewerClass } from '@/scm/utils/filePresentation';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { t } from '@/text';

/** What the Review knows about one changed image (from its comparison / status entry). */
export type ReviewImageCompareInput = Readonly<{
  change: 'modified' | 'added' | 'deleted';
  /** The before side's read (`scm.file.read`): a captured blob, or the live diff's before side. */
  beforeSelector: ScmFileAtRevisionRequest['selector'] | null;
}>;

function basename(path: string): string {
  return path.split(/[\\/]/).at(-1) || path;
}

function dimensions(info: ImageWellInfo | null): string | null {
  return info ? `${Math.round(info.width)} × ${Math.round(info.height)}` : null;
}

/** "512 × 512 → 1024 × 1024 · +551 KB": one tabular line, only the facts both sides have. */
function deltaLine(
  before: ImageWellInfo | null,
  after: ImageWellInfo | null,
  beforeBytes: number | null,
  afterBytes: number | null,
): string | null {
  const parts: string[] = [];
  const a = dimensions(before);
  const b = dimensions(after);
  if (a && b) parts.push(a === b ? a : `${a} → ${b}`);
  if (
    beforeBytes !== null &&
    afterBytes !== null &&
    beforeBytes !== afterBytes
  ) {
    const delta = afterBytes - beforeBytes;
    parts.push(
      `${delta > 0 ? '+' : '−'}${formatHappierDataBytes(Math.abs(delta), { kind: 'storage' })}`,
    );
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Review's changed-image body (P2 §3.10 first consumer, lab files RV1 / RV1a / RV1v): Before · HEAD and
 * After · working tree wells side by side from one preview budget; added or deleted show one well and a
 * pill. Tapping either opens the Media stage with [before, after]. Swipe and Onion are P5's modes.
 */
export function ReviewImageCompare(
  props: Readonly<{
    scope: WorkspaceScopeBase;
    filePath: string;
    viewer: FileViewerClass;
    /** Null when the Review has no comparison facts for this file: the current picture alone. */
    compare: ReviewImageCompareInput | null;
    after: UseFilePreviewSourceInput;
    signature: string | null;
    testID?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const stage = useMediaStage();
  const beforeRef = React.useRef<View | null>(null);
  const afterRef = React.useRef<View | null>(null);
  const [beforeInfo, setBeforeInfo] = React.useState<ImageWellInfo | null>(
    null,
  );
  const [afterInfo, setAfterInfo] = React.useState<ImageWellInfo | null>(null);
  const kind: 'image' | 'svg' = props.viewer.kind === 'svg' ? 'svg' : 'image';
  const compare = props.compare;
  const hasBefore =
    compare !== null && compare.change !== 'added' && compare.beforeSelector !== null;
  const hasAfter = compare?.change !== 'deleted';
  const before = useFileAtRevisionPreview({
    enabled: hasBefore,
    scope: props.scope,
    path: props.filePath,
    selector: compare?.beforeSelector ?? {
      side: 'before',
      area: 'pending',
    },
    mimeType: props.viewer.mimeType,
    signature: props.signature,
  });
  const title = basename(props.filePath);
  const openStage = (index: number) => {
    const items: MediaStageItem[] = [
      ...(hasBefore
        ? [
            {
              kind,
              title: `${title} · ${t('files.viewer.before')}`,
              source: before.previewInput,
              originRef: beforeRef,
            },
          ]
        : []),
      ...(hasAfter
        ? [
            {
              kind,
              title: `${title} · ${t('files.viewer.after')}`,
              source: props.after,
              originRef: afterRef,
            },
          ]
        : []),
    ];
    stage.open(items, Math.min(index, items.length - 1));
  };
  const beforeBytes =
    'sizeBytes' in before && typeof before.sizeBytes === 'number'
      ? before.sizeBytes
      : null;
  const afterBytes = props.after.sizeBytes ?? null;
  const delta =
    hasBefore && hasAfter
      ? deltaLine(beforeInfo, afterInfo, beforeBytes, afterBytes)
      : null;
  const single = !(hasBefore && hasAfter);

  const beforeWell = hasBefore ? (
    before.status === 'error' ? (
      <SurfaceStateCard
        kind="unavailable"
        size="line"
        title={t('files.viewer.loadFailed', {
          name: `${title} · ${t('files.viewer.beforeSide')}`,
        })}
        diagnosticCode={before.errorCode ?? before.error}
      />
    ) : (
      <ImageWell
        kind={kind}
        title={`${title} · ${t('files.viewer.before')}`}
        source={before.previewInput}
        alphaCapable={props.viewer.alphaCapable}
        layout="inline"
        originRef={beforeRef}
        onOpenStage={() => openStage(0)}
        onImageInfo={setBeforeInfo}
        testID="review-image-before"
      />
    )
  ) : null;
  const afterWell = hasAfter ? (
    <ImageWell
      kind={kind}
      title={`${title} · ${t('files.viewer.after')}`}
      source={props.after}
      alphaCapable={props.viewer.alphaCapable}
      layout="inline"
      originRef={afterRef}
      onOpenStage={() => openStage(hasBefore ? 1 : 0)}
      onImageInfo={setAfterInfo}
      testID="review-image-after"
    />
  ) : null;

  return (
    <View testID={props.testID} style={styles.root}>
      <View style={styles.modes}>
        {single && compare ? (
          <StatusPill
            variant="neutral"
            hideDot
            label={
              compare.change === 'added'
                ? t('files.viewer.added')
                : t('files.viewer.deleted')
            }
          />
        ) : (
          <View />
        )}
        {delta ? (
          <Text
            variant="meta"
            style={[
              { color: theme.colors.text.secondary },
              Typography.tabular(),
            ]}
          >
            {delta}
          </Text>
        ) : null}
      </View>
      <View style={single ? styles.one : styles.pair}>
        {beforeWell ? (
          <View style={styles.side}>
            {single ? null : (
              <Text
                variant="meta"
                style={{ color: theme.colors.text.secondary }}
              >{`${t('files.viewer.before')} · ${t('files.viewer.beforeSide')}`}</Text>
            )}
            {beforeWell}
          </View>
        ) : null}
        {afterWell ? (
          <View style={styles.side}>
            {single ? null : (
              <Text
                variant="meta"
                style={{ color: theme.colors.text.secondary }}
              >{`${t('files.viewer.after')} · ${t('files.viewer.afterSide')}`}</Text>
            )}
            {afterWell}
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    gap: theme.space.s10,
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s12,
  },
  modes: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.space.s12,
    minHeight: theme.space.s24,
  },
  pair: {
    flexDirection: { xs: 'column', md: 'row' },
    gap: theme.space.s12,
  },
  one: {
    alignSelf: 'stretch',
  },
  side: {
    flex: 1,
    minWidth: 0,
    gap: theme.space.s6,
  },
}));
