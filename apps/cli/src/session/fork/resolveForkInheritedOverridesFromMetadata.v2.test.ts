import { describe, expect, it } from 'vitest';

import { resolveForkInheritedOverridesFromMetadata } from './resolveForkInheritedOverridesFromMetadata';

describe('fork connected-services V2 inheritance', () => {
  it('preserves the exact brokered team-resource selection in spawn and metadata', () => {
    const connectedServices = {
      v: 2 as const,
      bindingsByServiceId: {
        'plugin.acme/service': {
          source: 'team_resource' as const,
          resourceId: 'resource-1',
          deliveryMode: 'brokered' as const,
        },
      },
    };
    const result = resolveForkInheritedOverridesFromMetadata({
      connectedServices,
      connectedServicesUpdatedAt: 200,
    }, null);
    expect(result.spawn).toMatchObject({ connectedServices, connectedServicesUpdatedAt: 200 });
    expect(result.metadata).toMatchObject({ connectedServices, connectedServicesUpdatedAt: 200 });
  });
});
