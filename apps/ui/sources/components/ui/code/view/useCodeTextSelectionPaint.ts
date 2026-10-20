import React from 'react';
import { Platform } from 'react-native';

const STYLE_ID = 'happier-code-text-selection';

/**
 * The read view's selection on web: the browser paints selectable text with its own solid highlight and white
 * text, so code rows (`data-code-text`, CodeLineRow) take the editors' selection wash instead and keep their ink.
 * One stylesheet for every code view; the colour comes from the code theme owner (`resolveCodeSelectionColor`).
 */
export function useCodeTextSelectionPaint(selectionColor: string): void {
  React.useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      document.head.appendChild(style);
    }
    style.textContent = `[data-code-text]::selection,[data-code-text] *::selection{background-color:${selectionColor}}`;
  }, [selectionColor]);
}
