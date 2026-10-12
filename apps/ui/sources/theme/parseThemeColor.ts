import Color, { type ColorInstance } from 'color';

/** Unistyles publishes authored web colours as root custom properties. */
export function readThemeDocumentColor(document: Document, color: string): string | null {
    const variable = /^var\((--[\w-]+)\)$/u.exec(color.trim())?.[1];
    if (!variable) return null;
    const value = document.defaultView?.getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
    return value && !value.startsWith('var(') ? value : null;
}

/** Numeric-only renderers resolve live web tokens here; invalid numeric inputs remain explicit errors. */
export function resolveThemeColor(value: string): ColorInstance {
    const concrete = value.trim().startsWith('var(')
        ? typeof document === 'undefined' ? null : readThemeDocumentColor(document, value)
        : value;
    if (concrete === null) throw new Error(`Unresolved theme color: ${value}`);
    return Color(concrete);
}

/** CSS-capable paints retain their authored expression when numeric resolution is unavailable. */
export function parseThemeColor(value: string): ColorInstance | null {
    try { return resolveThemeColor(value); } catch { return null; }
}
