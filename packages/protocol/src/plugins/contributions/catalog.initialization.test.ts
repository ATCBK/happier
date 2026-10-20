import { expect, it, vi } from 'vitest';

// Evaluate the cold entry graph during collection, outside the behavior deadline.
vi.resetModules();
const protocol = await import('../../index.js');

it('initializes the contribution catalog through a fresh Protocol entry graph', () => {
  expect(protocol.PLUGIN_CONTRIBUTION_CATALOG_V2.map((entry) => entry.manifestKey))
    .toEqual(expect.arrayContaining(protocol.PLUGIN_CORE_CONTRIBUTION_FAMILIES_V2.map((entry) => entry.family)));
  expect(protocol.PLUGIN_CONTRIBUTION_CATALOG_V2.length).toBeGreaterThan(0);
  expect(protocol.DaemonContributionRegistryProjectionDescribeResponseSchema).toBeDefined();
});
