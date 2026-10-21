/**
 * Read a declared manifest title, accepting both the plain-string and the
 * localized `{ key, fallback }` authoring shapes. Returns null when the
 * declaration carries no usable text, so callers decide their own fallback.
 */
export function readDeclaredAgentTitle(title: unknown): string | null {
    if (typeof title === 'string' && title.trim().length > 0) return title.trim();
    if (title && typeof title === 'object' && !Array.isArray(title)) {
        const localizedFallback = Reflect.get(title, 'fallback');
        if (typeof localizedFallback === 'string' && localizedFallback.trim().length > 0) {
            return localizedFallback.trim();
        }
    }
    return null;
}
