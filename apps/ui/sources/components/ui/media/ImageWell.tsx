import * as React from 'react';
import { Platform, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierImageCheckerboard, HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { previewUnavailableCard, resolvePreviewUnavailable } from './previewUnavailable';
import type { ImageBackground } from '@/sync/domains/settings/registry/local/localSettingDefinitions.files';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { useImageBacking, type ImageBackingKind } from './imageBacking';
import { MediaPicture, type MediaPictureSize } from './MediaPicture';
import { resolveImageWellFit } from './resolveImageWellFit';
import {
  useFilePreviewSource,
  type UseFilePreviewSourceInput,
} from './useFilePreviewSource';


export type ImageWellKind = ImageBackingKind;

export type ImageWellInfo = Readonly<{
  width: number;
  height: number;
  displayScale: number;
  pixelated: boolean;
}>;

export type ImageWellProps = Readonly<{
  kind: ImageWellKind;
  title: string;
  source: UseFilePreviewSourceInput;
  /** SVG text the page already holds (Source view); the preview renders it without reading bytes. */
  svgText?: string | null;
  /** From the classifier (`alphaCapable`): the board shows only where transparency is possible. */
  alphaCapable: boolean;
  /**
   * `fill`: the well is the page body (File page, Artifact) and centres the picture in it.
   * `inline`: the well takes the column width and the picture's height (Markdown image, Review side).
   */
  layout: 'fill' | 'inline';
  /** The picture's rect, measured by the Media stage for its flight. */
  originRef?: React.RefObject<View | null>;
  onOpenStage?: () => void;
  /** Natural size and display scale, for the page header meta ("1284 × 902 · PNG", "Shown at 4×"). */
  onImageInfo?: (info: ImageWellInfo) => void;
  testID?: string;
}>;

/** Device-local manual background per kind (`⋯ > Background`); absent kinds use the checkerboard. */
export function useImageWellBackground(
  kind: ImageWellKind,
): readonly [ImageBackground, (next: ImageBackground) => void] {
  const [byKind, setByKind] = useLocalSettingMutable(
    'filesImageBackgroundByKind',
  );
  const value = byKind[kind] ?? 'checkerboard';
  const set = React.useCallback(
    (next: ImageBackground) => setByKind({ ...byKind, [kind]: next }),
    [byKind, kind, setByKind],
  );
  return [value, set] as const;
}

/** The web picture of held SVG text: one `image/svg+xml` Blob URL, revoked by this hook (P2-I3, I4). */
function useSvgTextObjectUrl(text: string | null): string | null {
  const [uri, setUri] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (text === null) {
      setUri(null);
      return;
    }
    const next = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    setUri(next);
    return () => URL.revokeObjectURL(next);
  }, [text]);
  return uri;
}

function ImageWellPicture(
  props: ImageWellProps &
    Readonly<{ well: MediaPictureSize | null; onRetry: () => void }>,
) {
  const { theme } = useUnistyles();
  const backing = useImageBacking(props.kind, props.alphaCapable);
  const heldSvg = props.kind === 'svg' && props.svgText != null;
  const preview = useFilePreviewSource({
    ...props.source,
    enabled: props.source.enabled && !heldSvg,
  });
  const svgUri = useSvgTextObjectUrl(heldSvg && Platform.OS === 'web' ? props.svgText! : null);
  const [natural, setNatural] = React.useState<MediaPictureSize | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);
  const fit =
    natural && props.well
      ? resolveImageWellFit({
          imageWidth: natural.width,
          imageHeight: natural.height,
          wellWidth: props.well.width,
          wellHeight: props.well.height,
        })
      : null;
  const { onImageInfo } = props;
  const { onOpenStage } = props;
  const expandGesture = React.useMemo(() => Gesture.Pinch()
    .withTestId('image-well-expand')
    .enabled(Boolean(onOpenStage))
    .runOnJS(true)
    .onStart(event => {
      if (event.numberOfPointers === 2) onOpenStage?.();
    }), [onOpenStage]);
  React.useEffect(() => {
    if (natural && fit && fit.scale > 0)
      onImageInfo?.({
        width: natural.width,
        height: natural.height,
        displayScale: fit.scale,
        pixelated: fit.pixelated,
      });
  }, [fit?.pixelated, fit?.scale, natural, onImageInfo]);

  // Held SVG text: web draws it from this well's own pinned Blob, native validates the text itself.
  const uri = heldSvg
    ? Platform.OS === 'web'
      ? svgUri
      : ''
    : preview.status === 'loaded'
      ? preview.uri
      : null;
  if (preview.status === 'error' || failed) {
    // A picture that failed to decode is an unfinished read too: Retry draws it again.
    const card = previewUnavailableCard(preview.status === 'error'
      ? resolvePreviewUnavailable({ error: preview.error, errorCode: preview.errorCode, sizeBytes: props.source.sizeBytes })
      : { kind: 'loadFailed', error: failed! }, props.title);
    return (
      <SurfaceStateCard
        kind={card.kind}
        size="pane"
        title={card.title}
        {...(card.reason ? { reason: card.reason } : {})}
        {...(card.iconName ? { iconName: card.iconName } : {})}
        {...(card.diagnosticCode ? { diagnosticCode: card.diagnosticCode } : {})}
        {...(card.retryable ? { action: { label: t('common.retry'), onPress: props.onRetry } } : {})}
      />
    );
  }
  if (uri === null)
    return <ActivitySpinner size="small" color={theme.colors.text.secondary} />;

  const pictureSize =
    fit && fit.scale > 0 ? { width: fit.width, height: fit.height } : null;
  const { paper } = backing;
  const picture = (
    <View
      ref={props.originRef}
      collapsable={false}
      style={[
        styles.picture,
        pictureSize,
        paper ? { backgroundColor: paper } : null,
        { borderColor: theme.colors.border.default },
      ]}
    >
      {backing.checkerboard && pictureSize ? (
        <HappierImageCheckerboard color={theme.colors.text.primary} />
      ) : null}
      <MediaPicture
        kind={props.kind}
        uri={uri}
        svgText={props.svgText ?? null}
        size={pictureSize}
        pixelated={fit?.pixelated === true && fit.scale > 1}
        accessibilityLabel={props.title}
        onIntrinsicSize={setNatural}
        onError={setFailed}
        {...(props.testID ? { testID: `${props.testID}-picture` } : {})}
      />
    </View>
  );
  if (!props.onOpenStage) return picture;
  return (
    <GestureDetector gesture={expandGesture}>
    <HappierPressable
      accessibilityRole="button"
      accessibilityLabel={props.title}
      accessibilityHint={t('files.viewer.viewFullScreen')}
      onPress={props.onOpenStage}
      style={styles.pressable}
      {...(props.testID ? { testID: `${props.testID}-open` } : {})}
    >
      {picture}
    </HappierPressable>
    </GestureDetector>
  );
}

/**
 * The image body (P2 §3.6, lab files FV4): the picture fitted on the `surface.inset` well, never past
 * 1×, tiny images at a crisp integer scale, transparency on an ink checkerboard inside the picture's
 * rect only, and a press that lifts it into the Media stage. Size and kind belong to the page header.
 */
export function ImageWell(props: ImageWellProps) {
  const [well, setWell] = React.useState<MediaPictureSize | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  const onLayout = React.useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setWell((current) =>
      current?.width === width && current.height === height
        ? current
        : { width, height },
    );
  }, []);
  // Inline wells are as wide as the column; their height follows the picture, so fitting uses the width.
  const { theme } = useUnistyles();
  const inset = (props.layout === 'fill' ? theme.space.s32 : theme.space.s16) * 2;
  const fitBox = well
    ? {
        width: Math.max(0, well.width - inset),
        height: props.layout === 'inline' ? Number.MAX_SAFE_INTEGER : Math.max(0, well.height - inset),
      }
    : null;
  return (
    <View
      testID={props.testID}
      onLayout={onLayout}
      style={[
        styles.well,
        props.layout === 'fill' ? styles.fill : styles.inline,
      ]}
    >
      <ImageWellPicture
        key={attempt}
        {...props}
        well={fitBox}
        onRetry={() => setAttempt((value) => value + 1)}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  well: {
    backgroundColor: theme.colors.surface.inset,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  fill: {
    flex: 1,
    alignSelf: 'stretch',
    padding: theme.space.s32,
  },
  inline: {
    alignSelf: 'stretch',
    minHeight: theme.space.s48 * 2,
    padding: theme.space.s16,
    borderRadius: theme.space.s12,
  },
  picture: {
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
  },
  pressable: {
    borderRadius: theme.space.s4,
  },
}));
