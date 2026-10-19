import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { describe, expect, it } from 'vitest';

import type { ResolvedContributionRegistry } from '../types';

import { buildPluginProjectionV2 } from './v2';

function emptyRegistry(): ResolvedContributionRegistry {
    return createResolvedContributionRegistry({});
}

describe('portable plugin brand catalog projection', () => {
    it('projects the canonical admitted brand fact for both available and fallback packages', () => {
        const projection = buildPluginProjectionV2({
            registry: emptyRegistry(),
            generation: 7,
            brandAssetsByPluginId: {
                'acme.brand': {
                    state: 'available',
                    monochrome: true,
                    resource: { pluginId: 'acme.brand', localId: 'brand-icon' },
                    width: 64,
                    height: 64,
                    digest: `sha256:${'b'.repeat(64)}`,
                },
                'acme.missing': { state: 'missing' },
            },
        });

        expect(projection.installedPackagesById['acme.brand']).toMatchObject({
            id: 'acme.brand',
            displayName: 'acme.brand',
            brand: {
                state: 'available',
                monochrome: true,
                resource: { pluginId: 'acme.brand', localId: 'brand-icon' },
                width: 64,
                height: 64,
                digest: `sha256:${'b'.repeat(64)}`,
            },
        });
        expect(projection.installedPackagesById['acme.missing']).toMatchObject({
            id: 'acme.missing',
            brand: { state: 'missing' },
        });
        expect(projection.installedPackagesById['acme.brand']?.brand).not.toHaveProperty('path');
        expect(projection.installedPackagesById['acme.brand']?.brand).not.toHaveProperty('bytes');
    });
});
