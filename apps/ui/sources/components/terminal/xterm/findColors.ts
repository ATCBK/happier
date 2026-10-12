import { resolveThemeColor } from '@/theme/parseThemeColor';
import type { XtermFindColors } from './findEngine';

/** SearchAddon requires opaque #RRGGBB; composite the shared translucent tokens over this terminal. */
export function resolveXtermFindColors(colors: XtermFindColors, background: string): XtermFindColors {
    const opaque = (value: string) => {
        const foreground = resolveThemeColor(value);
        return resolveThemeColor(background).alpha(1).mix(foreground.alpha(1), foreground.alpha()).hex();
    };
    return { matchAll: opaque(colors.matchAll), matchCurrent: opaque(colors.matchCurrent) };
}
