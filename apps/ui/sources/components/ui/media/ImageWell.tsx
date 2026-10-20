import * as React from 'react';
import { Platform, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Defs, Pattern, Rect } from 'react-native-svg';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { ImageBackground } from '@/sync/domains/settings/registry/local/localSettingDefinitions.files';
import {
  useLocalSetting,
  useLocalSettingMutable,
} from '@/sync/domains/state/storage';
import { t } from '@/text';

import { MediaPicture, type MediaPictureSize } from './MediaPicture';
import { resolveImageWellFit } from './resolveImageWellFit';
import {
  useFilePreviewSource,
  type UseFilePreviewSourceInput,
} from './useFilePreviewSource';

/** One checker square of the transparency board (lab files FV4a: 8 px ink squares). */
const CHECKER_PX = 8;

export type ImageWellKind = 'image' | 'svg';

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

/** The transparency board of every image well; image compare layers draw on the same one. */
export function ImageWellCheckerboard(props: Readonly<{ color: string }>) {
  return (
    <Svg
      width="100%"
      height="100%"
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
    >
      <Defs>
        <Pattern
          id="image-well-checker"
          width={CHECKER_PX * 2}
          height={CHECKER_PX * 2}
          patternUnits="userSpaceOnUse"
        >
          <Rect
            width={CHECKER_PX * 2}
            height={CHECKER_PX * 2}
            fill={props.color}
            fillOpacity={0.04}
          />
          <Rect
            width={CHECKER_PX}
            height={CHECKER_PX}
            fill={props.color}
            fillOpacity={0.08}
          />
          <Rect
            x={CHECKER_PX}
            y={CHECKER_PX}
            width={CHECKER_PX}
            height={CHECKER_PX}
            fill={props.color}
            fillOpacity={0.08}
          />
        </Pattern>
      </Defs>
      <Rect width="100%" height="100%" fill="url(#image-well-checker)" />
    </Svg>
  );
}

function ImageWellPicture(
  props: ImageWellProps &
    Readonly<{ well: MediaPictureSize | null; onRetry: () => void }>,
) {
  const { theme } = useUnistyles();
  const background =
    useLocalSetting('filesImageBackgroundByKind')[props.kind] ?? 'checkerboard';
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
    return (
      <SurfaceStateCard
        kind="error"
        size="pane"
        title={t('files.viewer.loadFailed', { name: props.title })}
        diagnosticCode={preview.error ?? failed}
        action={{ label: t('common.retry'), onPress: props.onRetry }}
      />
    );
  }
  if (uri === null)
    return <ActivitySpinner size="small" color={theme.colors.text.secondary} />;

  const pictureSize =
    fit && fit.scale > 0 ? { width: fit.width, height: fit.height } : null;
  const paper =
    background === 'light'
      ? theme.colors.overlay.mediaPaper
      : background === 'dark'
        ? theme.colors.overlay.stageImmersive
        : null;
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
      {props.alphaCapable && background === 'checkerboard' && pictureSize ? (
        <ImageWellCheckerboard color={theme.colors.text.primary} />
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
