import * as React from 'react';
import type { PluginUiContextEnrichmentV1, PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';

/** Replace the mounted surface's host slot on commit; clear that same slot on retirement. */
export function useTriageCurrentUiContextPublication(
  hostApi: Pick<PluginUiHostApi, 'publishCurrentUiContext'>,
  currentUiContext: PluginUiContextEnrichmentV1,
): void {
  React.useLayoutEffect(() => {
    hostApi.publishCurrentUiContext(currentUiContext);
  }, [currentUiContext, hostApi]);
  React.useLayoutEffect(() => () => {
    hostApi.publishCurrentUiContext(null);
  }, [hostApi]);
}
