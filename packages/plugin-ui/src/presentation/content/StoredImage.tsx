import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { Image, Pressable, View } from 'react-native';
import { HappierImageCheckerboard } from '../media/ImageBacking.js';
import { resolveHappierStoredImageDimensions, resolveHappierStoredImageLayout, type HappierStoredImageDimensions } from './storedImageLayout.js';

export type HappierStoredImageHost = Readonly<{
  renderImage(input: Readonly<{ uri: string; testID?: string; onLoad(dimensions: HappierStoredImageDimensions): void }>): ReactNode;
}>;
export type HappierStoredImageProps = Readonly<{
  identity: string;
  status: 'disabled' | 'loading' | 'loaded' | 'error';
  uri?: string | null;
  dimensions?: Readonly<{ width?: number; height?: number }>;
  accessibilityLabel: string;
  accessibilityHint?: string;
  borderColor: string;
  backgroundColor: string;
  /** Ink colour of the transparency checkerboard; pass it only for an alpha-capable picture. */
  checkerboardColor?: string;
  placeholder: ReactNode;
  onPress?: () => void;
  host?: HappierStoredImageHost;
  testID?: string;
  imageTestID?: string;
}>;

/** One thumbnail presentation; transport, encryption, cache and preview custody stay host-owned. */
export function HappierStoredImage(props: HappierStoredImageProps): ReactElement {
  const [loadedDimensions, setLoadedDimensions] = useState<HappierStoredImageDimensions | null>(null);
  useEffect(() => setLoadedDimensions(null), [props.identity]);
  const onLoad = useCallback((value: HappierStoredImageDimensions) => {
    const dimensions = resolveHappierStoredImageDimensions(value);
    if (dimensions) setLoadedDimensions((current) => current?.width === dimensions.width && current.height === dimensions.height ? current : dimensions);
  }, []);
  const size = resolveHappierStoredImageLayout({ persistedDimensions: props.dimensions, loadedDimensions });
  return <Pressable testID={props.testID} accessibilityRole={props.onPress ? 'button' : 'image'}
    accessibilityLabel={props.accessibilityLabel} accessibilityHint={props.accessibilityHint} onPress={props.onPress}
    style={{ ...size, borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: props.borderColor, backgroundColor: props.backgroundColor }}>
    {props.status === 'loaded' && props.uri
      ? <>
        {props.checkerboardColor ? <HappierImageCheckerboard color={props.checkerboardColor} testID={props.testID ? `${props.testID}-backing` : undefined} /> : null}
        {props.host?.renderImage({ uri: props.uri, ...(props.imageTestID ? { testID: props.imageTestID } : {}), onLoad })
          ?? <Image testID={props.imageTestID} source={{ uri: props.uri }} resizeMode="contain" onLoad={(event) => onLoad(event.nativeEvent.source)}
            style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }} />}
      </>
      : <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: props.backgroundColor }}>{props.placeholder}</View>}
  </Pressable>;
}
