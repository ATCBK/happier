import * as React from 'react';
import { Platform, View, type ImageStyle, type StyleProp } from 'react-native';
import { StoredImagePicture } from './StoredImagePicture';

import { SafeNativeSvgXml, parseSafeNativeSvgXml } from './SafeNativeSvgXml';
import { useSvgPreviewText } from './useSvgPreviewText';

export type MediaPictureSize = Readonly<{ width: number; height: number }>;

export type MediaPictureProps = Readonly<{
  kind: 'image' | 'svg';
  /** A preview-owned URI (web Blob URL / native cache file) or a plugin's direct URI. */
  uri: string;
  /** The rendered size; until the intrinsic size is known the picture loads hidden. */
  size: MediaPictureSize | null;
  /** Tiny images scaled to an integer factor stay crisp. */
  pixelated?: boolean;
  fullResolution?: boolean;
  /** `cover` crops into a fixed box (gallery thumbnails); the default draws the picture at `size`. */
  fit?: 'fill' | 'cover';
  /** SVG source text the page already holds (File page Source view); skips reading the URI. */
  svgText?: string | null;
  accessibilityLabel?: string;
  onIntrinsicSize?: (size: MediaPictureSize) => void;
  onError?: (message: string) => void;
  style?: StyleProp<ImageStyle>;
  testID?: string;
}>;

const HIDDEN_PROBE: ImageStyle = {
  position: 'absolute',
  width: 1,
  height: 1,
  opacity: 0,
};

function readSvgLength(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0)
    return value;
  if (typeof value !== 'string' || /%$/.test(value.trim())) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Intrinsic size of a validated SVG: explicit width/height, else its viewBox. */
export function resolveSvgIntrinsicSize(
  props: Readonly<Record<string, unknown>> | null | undefined,
): MediaPictureSize | null {
  if (!props) return null;
  const width = readSvgLength(props.width);
  const height = readSvgLength(props.height);
  if (width && height) return { width, height };
  const viewBox =
    typeof props.viewBox === 'string'
      ? props.viewBox
          .trim()
          .split(/[\s,]+/)
          .map(Number)
      : [];
  if (viewBox.length === 4 && viewBox[2]! > 0 && viewBox[3]! > 0)
    return { width: viewBox[2]!, height: viewBox[3]! };
  return null;
}

function NativeSvgPicture(props: MediaPictureProps) {
  const { onIntrinsicSize, onError } = props;
  const text = useSvgPreviewText({
    xml: props.svgText ?? null,
    uri: props.svgText != null ? null : props.uri,
  });
  const ast = React.useMemo(
    () => (text.status === 'loaded' ? parseSafeNativeSvgXml(text.text) : null),
    [text.status, text.text],
  );
  React.useEffect(() => {
    if (text.status === 'error') onError?.(text.error);
    else if (text.status === 'loaded' && !ast) onError?.('unsafe_svg');
    else if (ast) {
      const size = resolveSvgIntrinsicSize(
        ast.props as Readonly<Record<string, unknown>>,
      );
      if (size) onIntrinsicSize?.(size);
      else onError?.('svg_without_size');
    }
  }, [ast, onError, onIntrinsicSize, text.status, text.error]);
  if (!ast || !props.size) return null;
  return (
    <View
      testID={props.testID}
      accessible
      accessibilityRole="image"
      accessibilityLabel={props.accessibilityLabel}
      style={[props.size, props.style]}
    >
      <SafeNativeSvgXml
        xml={text.status === 'loaded' ? text.text : ''}
        width={props.size.width}
        height={props.size.height}
      />
    </View>
  );
}

/**
 * One picture leaf for the Media stage and the viewer wells. Web renders both kinds as an image
 * (SVG from a pinned `image/svg+xml` Blob, scripts inert); native SVG goes through the validator.
 */
export function MediaPicture(props: MediaPictureProps) {
  if (props.kind === 'svg' && Platform.OS !== 'web')
    return <NativeSvgPicture {...props} />;
  return (
    <StoredImagePicture
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
      uri={props.uri}
      contentFit={props.fit ?? 'fill'}
      onLoad={props.onIntrinsicSize}
      onError={props.onError}
      pixelated={props.pixelated}
      fullResolution={props.fullResolution}
      style={[props.size ?? HIDDEN_PROBE, props.style]}
    />
  );
}
