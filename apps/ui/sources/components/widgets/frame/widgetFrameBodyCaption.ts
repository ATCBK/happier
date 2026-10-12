import * as React from 'react';

/**
 * Header projection only: a mounted body lends the one quiet fact that names what it shows ("Tokens by
 * agent · last 30 days") to its nearest shared frame. The placement still decides precedence (a
 * followed group value wins), and the body never renders a second header.
 */
export const WidgetFrameBodyCaptionContext = React.createContext<
  ((caption: string | null) => void) | null
>(null);

export function useWidgetFrameBodyCaption(caption: string | null): void {
  const lend = React.useContext(WidgetFrameBodyCaptionContext);
  React.useEffect(() => {
    lend?.(caption);
    return () => lend?.(null);
  }, [caption, lend]);
}

/**
 * The same lending for the header's meta slot: a mounted body's one live fact ("1 needs you",
 * "2 working"), at the frame's end. Pass an identity-stable node: a new one re-lends it.
 */
export const WidgetFrameBodyMetaContext = React.createContext<
  ((meta: React.ReactNode) => void) | null
>(null);

export function useWidgetFrameBodyMeta(meta: React.ReactNode): void {
  const lend = React.useContext(WidgetFrameBodyMetaContext);
  React.useEffect(() => {
    lend?.(meta);
    return () => lend?.(null);
  }, [meta, lend]);
}
