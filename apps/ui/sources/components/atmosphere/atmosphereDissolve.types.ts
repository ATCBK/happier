import type * as React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

export type AtmosphereDissolveProps = Readonly<{
    /** Shown once its art is drawn; hidden while not ready and after a send. */
    visible: boolean;
    /** How it leaves when `visible` turns false: the ordered climb (send) or a plain fade. */
    leave: 'climb' | 'fade';
    /** How it arrives when `visible` turns true: a fade, or at once when a moment hands over identical pixels. */
    arrive?: 'fade' | 'instant';
    /** The art's height in css px: the climb crosses it once. */
    height: number;
    reducedMotion: boolean;
    onHidden?: () => void;
    style?: StyleProp<ViewStyle>;
    children: React.ReactNode;
}>;
