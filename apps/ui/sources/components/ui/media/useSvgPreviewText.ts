import * as React from 'react';

import { decodeSvgPreviewBytes, requireSvgPreviewText } from './decodeSvgPreviewBytes';
import { readCachedSvgPreviewText } from './readCachedSvgPreviewText';

export type SvgPreviewTextState =
    | Readonly<{ status: 'disabled' | 'loading'; text: null; error: null }>
    | Readonly<{ status: 'loaded'; text: string; error: null }>
    | Readonly<{ status: 'error'; text: null; error: string }>;

/** Prefer already-read File XML, then supplied bytes, and decode an owned cache URI only as needed. */
export function useSvgPreviewText(input: Readonly<{
    enabled?: boolean;
    xml?: string | null;
    bytes?: Uint8Array | null;
    uri?: string | null;
}>): SvgPreviewTextState & Readonly<{ retry: () => void }> {
    const enabled = input.enabled !== false;
    const { xml, bytes, uri } = input;
    const direct = React.useMemo<SvgPreviewTextState | null>(() => {
        try {
            if (xml != null) return { status: 'loaded', text: requireSvgPreviewText(xml), error: null };
            if (bytes != null) return { status: 'loaded', text: decodeSvgPreviewBytes(bytes), error: null };
            return null;
        } catch (error) {
            return { status: 'error', text: null, error: error instanceof Error ? error.message : String(error) };
        }
    }, [xml, bytes]);
    const [attempt, retry] = React.useReducer((value: number) => value + 1, 0);
    const [resource, setResource] = React.useState<Readonly<{ uri: string; attempt: number; state: SvgPreviewTextState }> | null>(null);
    React.useEffect(() => {
        if (!enabled || direct || !uri) return;
        const controller = new AbortController();
        void readCachedSvgPreviewText(uri, controller.signal).then(text => {
            if (controller.signal.aborted) return;
            setResource({ uri, attempt, state: { status: 'loaded', text: requireSvgPreviewText(text), error: null } });
        }).catch(error => {
            if (controller.signal.aborted) return;
            setResource({ uri, attempt, state: { status: 'error', text: null, error: error instanceof Error ? error.message : String(error) } });
        });
        return () => controller.abort();
    }, [enabled, direct, uri, attempt]);
    const state: SvgPreviewTextState = !enabled ? { status: 'disabled', text: null, error: null }
        : direct ?? (!uri ? { status: 'disabled', text: null, error: null }
            : resource?.uri === uri && resource.attempt === attempt ? resource.state
                : { status: 'loading', text: null, error: null });
    return { ...state, retry };
}
