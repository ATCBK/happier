import { normalizeClaudeCapturedScreen } from '../screenState.js';

/** Claude 309 can draw its session-title rule below the active native dialog footer. */
export function readClaudeNativeDialogScreenLines(text: string): string[] {
    const lines = normalizeClaudeCapturedScreen(text).split('\n');
    while (lines.at(-1) === '') lines.pop();
    if (/^\s*[─━]{2,}\s+\S.*\s+[─━]+\s*$/u.test(lines.at(-1) ?? '')) lines.pop();
    return lines;
}
