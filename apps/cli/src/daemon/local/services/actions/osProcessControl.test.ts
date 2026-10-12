import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { installLocalServiceCensusFixture } from '../inventory/platform/censusFixture.testkit';

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, readFile: vi.fn(actual.readFile), readdir: vi.fn(actual.readdir), readlink: vi.fn(actual.readlink) };
});

import { createOsProcessControl } from './osProcessControl';
import { createTerminateDetectedService } from './terminate';
import { readProcessCensus } from '@/processes/census/processCensus';
import type { NormalizedLocalServiceInventoryEntry, NormalizedLocalServiceInventorySnapshot } from '../inventory/scanner';

function entry(
    overrides: Partial<NormalizedLocalServiceInventoryEntry> = {},
): NormalizedLocalServiceInventoryEntry {
    return {
        id: 'entry-a',
        machineId: 'machine-a',
        address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
        port: 5_173,
        protocol: 'tcp',
        detectedAt: 1_000,
        lastSeenAt: 1_000,
        state: 'listening',
        source: 'detected',
        labels: [],
        confidence: 'high',
        processOwnershipConfidence: 'high',
        workspaceAssociationConfidence: 'high',
        diagnostics: [],
        provenance: {
            process: {
                pid: 4_321,
                ppid: 300,
                processStartTimeMs: 1_717_171_717_000,
                lineagePids: [4_321, 300],
                command: 'npm run dev',
                cwd: '/repo',
                redacted: true,
            },
        },
        ...overrides,
    };
}

function snapshot(
    overrides: Partial<NormalizedLocalServiceInventorySnapshot> = {},
): NormalizedLocalServiceInventorySnapshot {
    return {
        v: 1,
        machineId: 'machine-a',
        generatedAt: 5_000,
        refreshState: 'idle',
        entries: [entry()],
        diagnostics: [],
        ...overrides,
    };
}

function errnoError(code: string): NodeJS.ErrnoException {
    const error = new Error(code) as NodeJS.ErrnoException;
    error.code = code;
    return error;
}

describe('detected listener termination through the shared owner', () => {
    it.each([false, true])('honors the requested force=%s through the shared listener-tree owner', async force => {
        const live = new Set([4321, 4322]);
        const install = () => installLocalServiceCensusFixture([
            ...(live.has(4321) ? [{ pid: 4321 }] : []),
            ...(live.has(4322) ? [{ pid: 4322, ppid: live.has(4321) ? 4321 : 1 }] : []),
        ]);
        install();
        const census = await readProcessCensus({ freshness: 'fresh' });
        if (census.status !== 'ok') throw new Error('fixture census unavailable');
        const start = census.rows.find(row => row.pid === 4321)?.start.startTimeMs;
        if (start === undefined) throw new Error('fixture listener identity unavailable');
        const target = entry({ provenance: { process: { pid: 4321, lineagePids: [4321], processStartTimeMs: start, command: '', redacted: true } } });
        const signals: Array<[number, NonNullable<Parameters<typeof process.kill>[1]>]> = [];
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
            if (signal === 0 && !live.has(pid)) throw errnoError('ESRCH');
            if (signal !== undefined && signal !== 0) signals.push([pid, signal]);
            if (pid === 4321 && (signal === 'SIGINT' || signal === 'SIGTERM')) live.delete(pid);
            if (signal === 'SIGKILL') live.delete(pid);
            install();
            return true;
        });
        const control = createOsProcessControl({
            refreshInventory: async () => snapshot({ generatedAt: Date.now(), entries: live.has(4321) ? [target] : [] }),
        });
        const result = await createTerminateDetectedService(control, { graceMs: 1, verifyPollMs: 0, verifyAttempts: 1 })({
            entry: target,
            now: Date.now(),
            request: { requestId: 'req', action: 'terminate_detected', force, target: { kind: 'inventory_entry', machineId: 'machine-a', inventoryEntryId: target.id } },
        });
        expect(result).toEqual({ status: 'succeeded' });
        expect(live.size).toBe(0);
        expect(signals.filter(([, signal]) => signal !== 'SIGKILL').map(([, signal]) => signal)).toEqual(force ? [] : ['SIGINT', 'SIGINT']);
        expect(signals.filter(([, signal]) => signal === 'SIGKILL').map(([pid]) => pid).sort()).toEqual(force ? [4321, 4322] : [4322]);
    });
});

describe('createOsProcessControl.probeListener', () => {
    it('resolves the live listener identity from the shared inventory refresh', async () => {
        const refreshInventory = vi.fn(async () => snapshot());
        const control = createOsProcessControl({ platform: 'darwin', refreshInventory });

        await expect(control.probeListener({ host: '127.0.0.1', port: 5_173 })).resolves.toEqual({
            status: 'held',
            identity: {
                pid: 4_321,
                startTime: 1_717_171_717_000,
                command: 'npm run dev',
                cwd: '/repo',
            },
        });
        expect(refreshInventory).toHaveBeenCalledTimes(1);
    });

    it('reports a failed listener scan as indeterminate, never as a released port', async () => {
        // A non-authoritative refresh retains the previous entries verbatim, still `listening`.
        const control = createOsProcessControl({
            platform: 'darwin',
            refreshInventory: async () => snapshot({ refreshState: 'error' }),
        });

        await expect(control.probeListener({ host: '127.0.0.1', port: 5_173 })).resolves.toEqual({
            status: 'indeterminate',
        });
    });

    it('reports an unattributed listener as indeterminate rather than free', async () => {
        const control = createOsProcessControl({
            platform: 'darwin',
            refreshInventory: async () => snapshot({ entries: [entry({ provenance: {} })] }),
        });

        await expect(control.probeListener({ host: '127.0.0.1', port: 5_173 })).resolves.toEqual({
            status: 'indeterminate',
        });
    });

    it('reports an authoritative empty scan as free', async () => {
        const control = createOsProcessControl({
            platform: 'darwin',
            refreshInventory: async () => snapshot({ entries: [] }),
        });

        await expect(control.probeListener({ host: '127.0.0.1', port: 5_173 })).resolves.toEqual({
            status: 'free',
        });
    });

    it('re-reads once when the coalesced refresh pre-dates the request, then gives up', async () => {
        const refreshInventory = vi.fn(async () => snapshot({ generatedAt: 4_000 }));
        const control = createOsProcessControl({ platform: 'darwin', refreshInventory });

        await expect(
            control.probeListener({ host: '127.0.0.1', port: 5_173, notBefore: 4_500 }),
        ).resolves.toEqual({ status: 'indeterminate' });
        expect(refreshInventory).toHaveBeenCalledTimes(2);
    });

    it('accepts the second read when it is fresh enough', async () => {
        const generatedAt = [4_000, 5_000];
        let index = 0;
        const control = createOsProcessControl({
            platform: 'darwin',
            refreshInventory: async () => snapshot({ generatedAt: generatedAt[index++] ?? 5_000 }),
        });

        await expect(
            control.probeListener({ host: '127.0.0.1', port: 5_173, notBefore: 4_500 }),
        ).resolves.toMatchObject({ status: 'held' });
    });
});
