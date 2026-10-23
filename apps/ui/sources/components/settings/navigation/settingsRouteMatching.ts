import { SETTINGS_ROUTE_CHROME_DEFINITIONS, type SettingsNestedNavigator } from './settingsRouteDefinitions';

export function matchSettingsRouteSegments(pattern: readonly string[], segments: readonly string[]): 'static' | 'dynamic' | null {
    if (pattern.length !== segments.length) return null;
    let dynamic = false;
    for (let i = 0; i < pattern.length; i += 1) {
        const part = pattern[i]!;
        if (part.startsWith('[') && part.endsWith(']')) {
            dynamic = true;
            continue;
        }
        if (part !== segments[i]) return null;
    }
    return dynamic ? 'dynamic' : 'static';
}

/** Resolve collection selection without loading the React/native header composition. */
export function resolveSettingsNestedRouteName(
    navigator: SettingsNestedNavigator,
    pathname: string | null | undefined,
): string | null {
    if (typeof pathname !== 'string') return null;
    const normalized = pathname.trim().replace(/\/+$/, '') || '/';
    if (!normalized.startsWith('/settings/')) return null;
    const rootPattern = navigator.split('/');
    const pathSegments = normalized.slice('/settings/'.length).split('/');
    if (pathSegments.length < rootPattern.length
        || matchSettingsRouteSegments(rootPattern, pathSegments.slice(0, rootPattern.length)) === null) return null;
    const segments = pathSegments.slice(rootPattern.length);
    let dynamicMatch: Readonly<{ name: string; staticSegments: number }> | null = null;
    for (const definition of SETTINGS_ROUTE_CHROME_DEFINITIONS) {
        if (definition.navigator !== navigator) continue;
        const nameSegments = definition.name.split('/');
        const candidate = nameSegments[nameSegments.length - 1] === 'index' ? nameSegments.slice(0, -1) : nameSegments;
        const match = matchSettingsRouteSegments(candidate, segments);
        if (match === 'static') return definition.name;
        if (match === 'dynamic') {
            const staticSegments = candidate.filter(part => !(part.startsWith('[') && part.endsWith(']'))).length;
            if (dynamicMatch === null || staticSegments > dynamicMatch.staticSegments) dynamicMatch = { name: definition.name, staticSegments };
        }
    }
    return dynamicMatch?.name ?? null;
}
