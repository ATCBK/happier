/** @moduleRealm any */
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { createPluginContributionIdentity } from '@happier-dev/protocol/plugins/contribution-identity';
import { PluginUiRendererChainBindingV1Schema } from '@happier-dev/protocol/plugins/contributions/ui/rendererChainBinding';
import type { PluginUiRendererChainBindingV1 } from '@happier-dev/protocol';

import type { TargetedContributionRendererDeclaration } from './targetedContributionAdmission.js';

export type PluginUiRendererChainResolution<TRenderer extends TargetedContributionRendererDeclaration> =
    | Readonly<{ ok: true; rendererChain: readonly TRenderer[] }>
    | Readonly<{ ok: false; code: 'renderer_not_found' | 'renderer_chain_invalid' }>;

export function buildPluginUiRendererContributionKey(pluginId: string, localId: string): string {
    return buildQualifiedPluginContributionKey(createPluginContributionIdentity({ pluginId, localId }));
}

/**
 * Resolves one manifest-declared renderer chain against the normalized
 * same-plugin renderer registry. Both target admission and Composer catalog
 * projection consume this owner so neither path can select a renderer by a
 * weaker local-id lookup.
 */
export function resolvePluginUiRendererChain<TRenderer extends TargetedContributionRendererDeclaration>(input: Readonly<{
    binding: PluginUiRendererChainBindingV1;
    contributorPluginId: string;
    renderersByQualifiedId: ReadonlyMap<string, TRenderer>;
}>): PluginUiRendererChainResolution<TRenderer> {
    const binding = PluginUiRendererChainBindingV1Schema.safeParse(input.binding);
    if (!binding.success) {
        return Object.freeze({ ok: false, code: 'renderer_chain_invalid' });
    }
    const localIds = [binding.data.renderer, ...(binding.data.fallbackRenderers ?? [])];
    const rendererChain: TRenderer[] = [];
    for (const localId of localIds) {
        const renderer = input.renderersByQualifiedId.get(
            buildPluginUiRendererContributionKey(input.contributorPluginId, localId),
        );
        if (!renderer) return Object.freeze({ ok: false, code: 'renderer_not_found' });
        if (renderer.pluginId !== input.contributorPluginId
            || renderer.identity.pluginId !== input.contributorPluginId
            || renderer.identity.localId !== localId
            || renderer.definition.id !== localId) {
            return Object.freeze({ ok: false, code: 'renderer_chain_invalid' });
        }
        rendererChain.push(renderer);
    }
    return Object.freeze({ ok: true, rendererChain: Object.freeze(rendererChain) });
}
