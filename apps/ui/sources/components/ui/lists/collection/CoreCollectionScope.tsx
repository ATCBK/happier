import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { PluginUiHostPresentationScope, type PluginUiPresentationHost } from '@happier-dev/plugin-ui/advanced';
import { projectHappierUiEnvironment } from '@happier-dev/plugin-ui/environment';

import { usePluginSurfaceEnvironment } from '@/components/plugins/surfaces/pluginSurfaceContext';
import { resolvePluginUiFrameworkTranslations } from '@/components/plugins/surfaces/pluginUiFrameworkTranslations';
import { createPluginUiPrivatePresentationHost } from '@/components/plugins/surfaces/pluginUiPrivatePresentationHost';
import { projectPluginUiHostPalette } from '@/components/plugins/surfaces/pluginUiThemeProjection';

/**
 * Happier core's binding of the public `Collection` on a core page: the environment, host renderers and facts a
 * plugin surface mounted in the app receives (the app's theme, type roles and page colours, its locale for the
 * framework chrome, its icons and popovers), plus the page's own scroller for a page-sized collection. Core pages
 * render the one Collection instead of a page-local grid or list. Core forms that draw the public typed field
 * (`HappierInputField`: Action, Workflow and widget inputs) sit in it too, so a field's choices float in the app's
 * anchored popover like every other menu.
 */
export const CoreCollectionScope = React.memo(function CoreCollectionScope(props: Readonly<{
    /** The page's scroller (`ItemList` with the page's anatomy) for `Collection scroll="page"`. */
    renderPageScroller?: (children: React.ReactNode) => React.ReactNode;
    children: React.ReactNode;
}>) {
    const { theme } = useUnistyles();
    const surface = usePluginSurfaceEnvironment(Platform.OS);
    const environment = React.useMemo(
        () => projectHappierUiEnvironment({ ...surface, translations: resolvePluginUiFrameworkTranslations() }),
        [surface],
    );
    const { renderPageScroller } = props;
    const presentationHost = React.useMemo((): PluginUiPresentationHost => ({
        ...createPluginUiPrivatePresentationHost(undefined, {
            direction: surface.direction,
            palette: projectPluginUiHostPalette(theme),
        }),
        ...(renderPageScroller === undefined ? {} : { renderPageScroller }),
    }) as unknown as PluginUiPresentationHost, [renderPageScroller, surface.direction, theme]);
    return (
        <PluginUiHostPresentationScope environment={environment} presentationHost={presentationHost}>
            {props.children}
        </PluginUiHostPresentationScope>
    );
});
