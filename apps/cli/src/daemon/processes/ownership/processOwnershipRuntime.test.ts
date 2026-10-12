import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localServiceProcfsFixture } from '@/daemon/local/services/inventory/platform/censusFixture.testkit';
import { listHappierProcessRoots } from '../roots/listHappierProcessRoots';
import { createProcessOwnershipRuntime } from './processOwnershipRuntime';

describe('processOwnershipRuntime root observation boundary', () => {
    it('returns typed unavailability for a genuine lifecycle filesystem read failure, never an empty authoritative owner table', async () => {
        const runtime = createProcessOwnershipRuntime({ daemonScopeKey: '123456789abc',
            censusDependencies: { platform: 'linux', linuxBoundary: localServiceProcfsFixture([]) },
            listRoots: async snapshot => {
                // Genuine missing lifecycle source; only the procfs OS adapter is a fixture.
                await readFile(join(tmpdir(), randomUUID(), 'session-marker.json'), 'utf8');
                return listHappierProcessRoots({ snapshot });
            } });
        await expect(runtime.readOwners({ freshness: 'fresh' })).resolves.toEqual({ status: 'unavailable', reason: 'read_failed' });
        await expect(runtime.resolveSnapshot({ status: 'ok', capturedAtMs: 1000, logicalCpus: 1, rows: [] }))
            .resolves.toEqual({ status: 'unavailable', reason: 'read_failed' });
    });
});
