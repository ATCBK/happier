import {
    createBoundPluginSurfaceController,
    type BoundPluginSurfaceController,
} from '@/components/plugins/surfaces/boundPluginSurfaceController';

/** A physical renderer lifetime supplied by the real incumbent mount owner. */
export function createPluginSurfaceMountLifetimeFixture(accountId = 'account-a'): BoundPluginSurfaceController {
    return createBoundPluginSurfaceController({
        facts: {
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            surfaceId: 'fixture-hosted-surface',
            placement: 'sessionPane',
            platform: 'web',
            interactionEnabled: false,
            daemonInteractionEnabled: false,
            accountLifetime: {
                scope: { serverId: 'server-a', accountId },
                isCurrent: () => true,
                onRetire: () => ({ dispose: () => {} }),
            },
        },
    });
}
