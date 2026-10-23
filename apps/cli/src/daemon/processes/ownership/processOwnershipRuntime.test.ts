import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localServiceProcfsFixture } from '@/daemon/local/services/inventory/platform/censusFixture.testkit';
import { listHappierProcessRoots } from '../roots/listHappierProcessRoots';
import { createProcessOwnershipRuntime } from './processOwnershipRuntime';

describe('processOwnershipRuntime root observation boundary', () => {
    it('shares the complete passive observation, separates field and attribution demand, and never retains a settled table', async () => {
        const procfs = localServiceProcfsFixture(Array.from({ length: 1000 }, (_, index) => ({ pid: process.pid + index + 1 })));
        let nativeReads = 0;
        const projections: Array<'retained' | 'recover'> = [];
        const runtime = createProcessOwnershipRuntime({ daemonScopeKey: '123456789abc', platform: 'linux',
            censusDependencies: { platform: 'linux', linuxBoundary: { ...procfs,
                readdir: async path => { nativeReads++; return procfs.readdir(path); } } },
            listRoots: (snapshot, options) => {
                projections.push(options.requesterAttribution ?? 'recover');
                return listHappierProcessRoots({ snapshot, platform: 'linux', daemonScopeKey: '123456789abc' });
            } });
        const sameDemand = Array.from({ length: 8 }, (_, index) => runtime.readOwners({ freshness: 'shared',
            fields: index % 2 ? ['argv', 'cwd'] : ['cwd', 'argv'] }));
        const answers = await Promise.all(sameDemand);
        expect(answers.every(answer => answer.status === 'ok' && answer.snapshot.rows.length === 1001)).toBe(true);
        expect(nativeReads).toBe(1);
        expect(projections).toEqual(['recover']);

        await Promise.all([runtime.readOwners({ freshness: 'shared', fields: [] }),
            runtime.readOwners({ freshness: 'shared', fields: ['argv'] }),
            runtime.readOwners({ freshness: 'shared', fields: ['argv'], requesterAttribution: 'retained' })]);
        expect(nativeReads).toBe(3);
        expect(projections.slice(1).sort()).toEqual(['recover', 'recover', 'retained']);
        await runtime.readOwners({ freshness: 'shared', fields: ['cwd', 'argv'] });
        expect(nativeReads).toBe(4);
        expect(projections).toHaveLength(5);
        await Promise.all([runtime.readOwners({ freshness: 'fresh', fields: [] }),
            runtime.readOwners({ freshness: 'fresh', fields: [] })]);
        expect(nativeReads).toBe(6);
        expect(projections).toHaveLength(7);
    });

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
