import * as React from 'react';
import type { View } from 'react-native';

type NativeItemReveal = (node: View) => (() => void) | undefined;

const TranscriptNativeItemRevealContext = React.createContext<NativeItemReveal | null>(null);

/** A mounted child asks its transcript renderer to measure and reveal it through the jump owner. */
export function useTranscriptNativeItemReveal(): NativeItemReveal | null {
    return React.useContext(TranscriptNativeItemRevealContext);
}

export function TranscriptNativeItemRevealProvider(props: Readonly<{
    index: number;
    reveal: (index: number, node: View) => (() => void) | undefined;
    children: React.ReactNode;
}>) {
    const { index, reveal } = props;
    const value = React.useCallback((node: View) => reveal(index, node), [index, reveal]);
    return <TranscriptNativeItemRevealContext.Provider value={value}>{props.children}</TranscriptNativeItemRevealContext.Provider>;
}
