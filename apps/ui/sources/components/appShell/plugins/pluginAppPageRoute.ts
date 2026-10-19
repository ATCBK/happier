import { normalizePluginUiSubPathV1 } from '@happier-dev/protocol/plugins/ui';

export const PLUGIN_APP_PAGE_ROUTE_PREFIX = '/plugins';

/** The host owns the prefix and encodes each plugin-local identity/location segment. */
export function buildPluginAppPageRoutePath(input: Readonly<{
    pluginId: string; localId: string; subPath?: string;
}>): string {
    const root = `${PLUGIN_APP_PAGE_ROUTE_PREFIX}/${encodeURIComponent(input.pluginId)}/${encodeURIComponent(input.localId)}`;
    const normalized = input.subPath === undefined ? '' : (normalizePluginUiSubPathV1(input.subPath) ?? '');
    return normalized.length === 0 ? root : `${root}/${normalized.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * The two identity segments of a generated plugin-page route.
 *
 * Expo Router hands a dynamic segment back as a string or, on a repeated match,
 * an array; both spellings resolve to the same identity here so the screen never
 * carries a second parsing rule. A missing or empty segment resolves to `''`,
 * which the page catalog fails closed on — the host never guesses a page.
 */
export type PluginAppPageRouteIdentity = Readonly<{
    pluginId: string;
    localId: string;
}>;

function readRouteSegment(value: unknown): string {
    if (Array.isArray(value)) {
        return readRouteSegment(value[0]);
    }
    return typeof value === 'string' ? value.trim() : '';
}

export function readPluginAppPageRouteIdentity(
    params: Readonly<Record<string, unknown>>,
): PluginAppPageRouteIdentity {
    return {
        pluginId: readRouteSegment(params.pluginId),
        localId: readRouteSegment(params.localId),
    };
}
