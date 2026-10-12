import * as React from 'react';

/**
 * The body room of the frame a widget's content sits in: `null` outside a widget frame. A body that
 * is still on its first load (a plugin surface whose runtime is establishing) reads it to draw the
 * frame's own loading rows instead of a second, different loading state inside the card.
 */
export const WidgetFrameBodyRowsContext = React.createContext<number | null>(null);

/**
 * Whether this content is a widget's body inside its frame. Every framed widget has it, sized or not
 * (a widget in a side area or a stacked column carries no size presentation), so a body that drops
 * its page tools inside a card asks this, never whether a size presentation happens to exist.
 */
export function useIsWidgetFrameBody(): boolean {
    return React.useContext(WidgetFrameBodyRowsContext) !== null;
}
