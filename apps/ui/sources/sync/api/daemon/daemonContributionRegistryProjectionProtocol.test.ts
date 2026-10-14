import { describe, expect, it } from 'vitest';

import { parseDaemonContributionRegistryProjectionDescribeResponse } from './daemonContributionRegistryProjectionProtocol';

describe('daemon contribution registry projection response', () => {
    it('admits the daemon response envelope while validating its projection separately', () => {
        const projection = { v: 2, generation: 7, familiesById: {} } as const;
        expect(parseDaemonContributionRegistryProjectionDescribeResponse({
            protocolVersion: 1,
            projection,
        })).toEqual({ projection: expect.objectContaining(projection) });
    });
});
