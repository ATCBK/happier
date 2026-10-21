import * as React from 'react';
import { Platform, type ImageStyle, type StyleProp } from 'react-native';
import type { HappierStoredImageHost } from '@happier-dev/plugin-ui/presentation';

import { SafeExpoImage, type SafeExpoImageContentFit } from './SafeExpoImage';

type Dimensions = Readonly<{ width: number; height: number }>;
type LoadEvent = Readonly<{
    source?: Dimensions;
    nativeEvent?: Readonly<{ source: Dimensions }>;
}>;
type ErrorEvent = Readonly<{ error?: string; nativeEvent?: Readonly<{ error: string }> }>;

const fill: ImageStyle = { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 };
const pixelatedStyle = Platform.OS === 'web'
    ? ({ imageRendering: 'pixelated' } as unknown as ImageStyle) : null;

/** Shared host decoder for stored thumbnails, media wells and the stage; transport stays with previews. */
export function StoredImagePicture(props: Readonly<{
    uri: string;
    onLoad?: (size: Dimensions) => void;
    onError?: (message: string) => void;
    contentFit?: SafeExpoImageContentFit;
    pixelated?: boolean;
    /** Preserve full raster resolution once a zoom settles above fit. */
    fullResolution?: boolean;
    style?: StyleProp<ImageStyle>;
    accessibilityLabel?: string;
    testID?: string;
}>) {
    const { onLoad, onError } = props;
    const source = React.useMemo(() => ({ uri: props.uri }), [props.uri]);
    const handleLoad = React.useCallback((event: LoadEvent) => {
        const size = event.source ?? event.nativeEvent?.source;
        if (size && size.width > 0 && size.height > 0) onLoad?.({ width: size.width, height: size.height });
    }, [onLoad]);
    const handleError = React.useCallback((event: ErrorEvent) => {
        const error = event.error ?? event.nativeEvent?.error;
        if (error) onError?.(error);
    }, [onError]);
    const style = props.style ?? fill;
    return <SafeExpoImage source={source} contentFit={props.contentFit ?? 'contain'}
        allowDownscaling={!props.fullResolution}
        onLoad={handleLoad} onError={handleError}
        accessibilityRole="image" accessibilityLabel={props.accessibilityLabel} testID={props.testID}
        style={props.pixelated && pixelatedStyle ? [style, pixelatedStyle] : style} />;
}

export const STORED_IMAGE_HOST: HappierStoredImageHost = Object.freeze({
    renderImage: ({ uri, testID, onLoad }) => <StoredImagePicture uri={uri} testID={testID} onLoad={onLoad} />,
} satisfies HappierStoredImageHost);
