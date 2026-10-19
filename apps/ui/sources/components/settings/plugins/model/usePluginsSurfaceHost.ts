import { usePathname } from '@/components/appShell/workspace/destinationRoute';

import { resolvePluginsSurfaceHost, type PluginsSurfaceHost } from './pluginsSurfaceRoutes';

/** The host the current screen is rendered in. */
export function usePluginsSurfaceHost(): PluginsSurfaceHost {
    return resolvePluginsSurfaceHost(usePathname());
}
