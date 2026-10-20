import type { ITerminalOptions, Terminal } from '@xterm/xterm';

type XtermCursorAppearance = Readonly<{
    options: Pick<ITerminalOptions, 'cursorBlink' | 'cursorStyle' | 'cursorInactiveStyle' | 'disableStdin'>;
    color: string;
}>;

export function resolveXtermCursorAppearance(readOnly: boolean, cursorColor: string): XtermCursorAppearance {
    return {
        options: {
            cursorBlink: !readOnly,
            // A transparent bar also hides a focused cursor without repainting the cell's glyph
            // in the block cursor's accent color. Inactive cursors have a dedicated hidden style.
            cursorStyle: readOnly ? 'bar' : 'block',
            cursorInactiveStyle: readOnly ? 'none' : 'outline',
            disableStdin: readOnly,
        },
        color: readOnly ? '#00000000' : cursorColor,
    };
}

export function registerXtermReadOnlyCursorPolicy(terminal: Pick<Terminal, 'parser'>, isReadOnly: () => boolean): Readonly<{ dispose: () => void }> {
    // Replay can include cursor style/color commands. Consume only those commands while the
    // host hides the cursor; writable terminals retain xterm's own cursor command handling.
    const handlers = [
        terminal.parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, isReadOnly),
        terminal.parser.registerOscHandler(12, isReadOnly),
        terminal.parser.registerOscHandler(112, isReadOnly),
    ];
    return { dispose: () => { for (const handler of handlers) handler.dispose(); } };
}
