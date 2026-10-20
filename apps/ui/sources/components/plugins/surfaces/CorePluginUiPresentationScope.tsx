import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { PluginUiHostPresentationScope, type PluginUiPresentationHost } from '@happier-dev/plugin-ui/advanced';
import { projectHappierUiEnvironment } from '@happier-dev/plugin-ui/environment';

import { usePluginSurfaceEnvironment } from './pluginSurfaceContext';
import { resolvePluginUiFrameworkTranslations } from './pluginUiFrameworkTranslations';
import { createPluginUiPrivatePresentationHost } from './pluginUiPrivatePresentationHost';
import { projectPluginUiHostPalette } from './pluginUiThemeProjection';
import { usePluginUiMediaStage } from './usePluginUiMediaStage';

/** Core uses the same public presenters and real platform bindings as an installed plugin, without plugin state. */
export function CorePluginUiPresentationScope(props: Readonly<{
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
  const mediaStage = usePluginUiMediaStage();
  const presentationHost = React.useMemo((): PluginUiPresentationHost => ({
    ...createPluginUiPrivatePresentationHost(undefined, {
      direction: surface.direction,
      palette: projectPluginUiHostPalette(theme),
      mediaStage,
    }),
    ...(renderPageScroller === undefined ? {} : { renderPageScroller }),
  }) as unknown as PluginUiPresentationHost, [mediaStage, renderPageScroller, surface.direction, theme]);
  return <PluginUiHostPresentationScope environment={environment} presentationHost={presentationHost}>
    {props.children}
  </PluginUiHostPresentationScope>;
}
