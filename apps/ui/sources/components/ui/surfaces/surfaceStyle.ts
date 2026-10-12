import { StyleSheet, type StyleProp, type TextStyle } from 'react-native';

/** Read one winning property without enumerating away Unistyles' hidden values. */
export function readSurfaceStyleProperty<K extends keyof TextStyle>(style: unknown, key: K): TextStyle[K] | undefined {
    if (!style) return undefined;
    if (Array.isArray(style)) {
        return style.reduce<TextStyle[K] | undefined>((value, entry: unknown) => readSurfaceStyleProperty(entry, key) ?? value, undefined);
    }
    // RNW's flatten enumerates even a single object; Unistyles exposes its
    // values as non-enumerable properties. Read that object before flattening.
    // This renderer boundary accepts both portable and native style arrays.
    if (typeof style === 'object') return (style as TextStyle)[key];
    if (typeof style === 'number') return StyleSheet.flatten<TextStyle>(style as StyleProp<TextStyle>)?.[key];
    return undefined;
}
