/** Expo file-route matching, shared by destination identity and body loading. */
export function matchWorkspaceRoutePatterns(
    routeKeys: readonly string[],
    pathname: string,
): Readonly<{ routeKey: string; params: Readonly<Record<string, string>> }> | null {
    return createWorkspaceRouteMatcher(routeKeys)(pathname);
}

/** Prepare a fixed registry once; pathname reads retain the same matching policy. */
export function createWorkspaceRouteMatcher(
    routeKeys: readonly string[],
): (pathname: string) => Readonly<{ routeKey: string; params: Readonly<Record<string, string>> }> | null {
    const candidates = routeKeys.map((routeKey) => ({ routeKey, segments: routeKey.split('/').filter(Boolean) }))
        .sort((a, b) => {
            for (let i = 0; i < Math.max(a.segments.length, b.segments.length); i++) {
                const rank = (segment: string | undefined) => !segment ? 0 : segment.startsWith('[[...') ? 1
                    : segment.startsWith('[...') ? 2 : segment.startsWith('[') ? 3 : 4;
                const difference = rank(b.segments[i]) - rank(a.segments[i]);
                if (difference) return difference;
            }
            return 0;
        });
    return (pathname) => {
        let parts: string[];
        try { parts = pathname.split(/[?#]/, 1)[0]!.split('/').filter(Boolean).map(decodeURIComponent); }
        catch { return null; }
        for (const { routeKey, segments } of candidates) {
            const params: Record<string, string> = {};
            let cursor = 0;
            let matched = true;
            for (const segment of segments) {
                if (segment.startsWith('[[...') || segment.startsWith('[...')) {
                    const optional = segment.startsWith('[[...');
                    if (!optional && cursor === parts.length) { matched = false; break; }
                    const key = optional ? segment.slice(5, -2) : segment.slice(4, -1);
                    if (cursor < parts.length) params[key] = parts.slice(cursor).join('/');
                    cursor = parts.length;
                } else if (segment.startsWith('[') && segment.endsWith(']')) {
                    if (cursor === parts.length) { matched = false; break; }
                    params[segment.slice(1, -1)] = parts[cursor++]!;
                } else if (parts[cursor++] !== segment) { matched = false; break; }
            }
            if (matched && cursor === parts.length) return { routeKey, params };
        }
        return null;
    };
}
