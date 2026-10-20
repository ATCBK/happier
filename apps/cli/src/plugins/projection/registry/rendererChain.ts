export { buildPluginUiRendererContributionKey, resolvePluginUiRendererChain } from '@happier-dev/plugin-sdk/host/registration';
import type { ResolvedUiRendererV2Contribution } from './types';
import type { PluginUiRendererChainResolution as PortablePluginUiRendererChainResolution } from '@happier-dev/plugin-sdk/host/registration';
export type PluginUiRendererChainResolution = PortablePluginUiRendererChainResolution<ResolvedUiRendererV2Contribution>;
