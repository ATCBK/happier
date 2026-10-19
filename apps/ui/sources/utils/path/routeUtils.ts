import type { Href, HrefObject } from 'expo-router';

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

/** Single owner for app-internal navigation destinations from persisted or remote input. */
export function normalizeInternalReturnPath(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (CONTROL_CHARACTER_PATTERN.test(trimmed) || trimmed.includes('\\')) return null;

    let decoded: string;
    try {
        decoded = decodeURIComponent(trimmed);
    } catch {
        return null;
    }

    if (CONTROL_CHARACTER_PATTERN.test(decoded) || decoded.includes('\\')) return null;
    if (decoded.includes(':')) return null;
    if (!decoded.startsWith('/')) return null;
    if (decoded.startsWith('//')) return null;
    if (decoded.includes('//')) return null;

    return decoded;
}

export function coerceRelativeRoute(raw: string): string | null {
    return normalizeInternalReturnPath(raw);
}

/** Admit a runtime internal destination without claiming generated route membership. */
export function admitInternalRouteHref(destination: string | HrefObject): Href {
    const href = typeof destination === 'string'
        ? destination.trim()
        : { ...destination, pathname: destination.pathname.trim() };
    // Query/hash values and object params are already serialized or belong to Expo's serializer.
    // Validate only the navigation path; never decode those opaque values a second time.
    const pathname = (typeof href === 'string' ? href : href.pathname).split(/[?#]/, 1)[0];
    if (normalizeInternalReturnPath(pathname) === null) throw new Error('Invalid internal route destination');
    // Approved SDK boundary: Expo dispatch accepts admitted runtime paths beyond generated route names.
    return href as Href;
}
