import * as React from 'react';

import { describe, expect, it } from 'vitest';

import { useActiveSelectionMachineGroups } from './useActiveSelectionMachineGroups';
import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type ProbeProps = Readonly<{
    allMachines: any[];
    serverProfiles?: any[];
    machineListByServerId?: Record<string, any[] | null>;
    onValue: (value: ReturnType<typeof useActiveSelectionMachineGroups>) => void;
}>;

function Probe(props: ProbeProps) {
    const value = useActiveSelectionMachineGroups({
        activeServerSnapshot: { serverId: 'server-a', serverUrl: 'https://a.example.test', generation: 1 } as any,
        allMachines: props.allMachines as any,
        serverProfiles: (props.serverProfiles ?? [{ id: 'server-a', name: 'Server A', serverUrl: 'https://a.example.test', lastUsedAt: 1 }]) as any,
        machineListByServerId: props.machineListByServerId ?? {},
        machineListStatusByServerId: {},
        settings: {
            serverSelectionGroups: null,
            serverSelectionActiveTargetKind: null,
            serverSelectionActiveTargetId: null,
        },
    });

    React.useEffect(() => {
        props.onValue(value);
    }, [value, props]);

    return null;
}

describe('useActiveSelectionMachineGroups', () => {
    it('filters revoked machines out of visible groups and hasAnyVisibleMachines', async () => {
        const captured: any[] = [];
        const allMachines = [
            { id: 'm-ok', revokedAt: null },
            { id: 'm-revoked', revokedAt: 123 },
        ];

        await renderScreen(<Probe allMachines={allMachines} onValue={(value) => captured.push(value)} />);

        const latest = captured.at(-1);
        expect(latest.visibleMachineGroups).toHaveLength(1);
        expect(latest.visibleMachineGroups[0].machines.map((m: any) => m.id)).toEqual(['m-ok']);
        expect(latest.hasAnyVisibleMachines).toBe(true);
        // Warm/socket rows are not a completed fleet census; preset pins must wait for the list reader.
        expect(latest.visibleMachineGroups[0].status).toBe('loading');
    });

    it('reports no visible machines when all are revoked', async () => {
        const captured: any[] = [];
        const allMachines = [
            { id: 'm-revoked', revokedAt: 123 },
        ];

        await renderScreen(<Probe allMachines={allMachines} onValue={(value) => captured.push(value)} />);

        const latest = captured.at(-1);
        expect(latest.visibleMachineGroups[0].machines).toEqual([]);
        expect(latest.hasAnyVisibleMachines).toBe(false);
    });

    it('falls back to active machines when the active server scoped cache is empty', async () => {
        const captured: any[] = [];
        const allMachines = [
            { id: 'm-active', revokedAt: null },
        ];

        await renderScreen(
            <Probe
                allMachines={allMachines}
                machineListByServerId={{ 'server-a': [] }}
                onValue={(value) => captured.push(value)}
            />,
        );

        const latest = captured.at(-1);
        expect(latest.visibleMachineGroups[0].machines.map((m: any) => m.id)).toEqual(['m-active']);
        expect(latest.hasAnyVisibleMachines).toBe(true);
    });

    it('resolves machine groups with identity-backed server scope ids', async () => {
        const captured: any[] = [];

        function IdentityProbe() {
            const value = useActiveSelectionMachineGroups({
                activeServerSnapshot: { serverId: 'srv_identity_active', serverUrl: 'https://a.example.test', generation: 1 } as any,
                allMachines: [],
                serverProfiles: [
                    {
                        id: 'server-a',
                        name: 'Server A',
                        serverUrl: 'https://a.example.test',
                        serverIdentityId: 'srv_identity_active',
                        lastUsedAt: 1,
                    },
                ] as any,
                machineListByServerId: {
                    srv_identity_active: [{ id: 'm-identity', revokedAt: null }] as any,
                },
                machineListStatusByServerId: { srv_identity_active: 'idle' },
                settings: {
                    serverSelectionGroups: null,
                    serverSelectionActiveTargetKind: null,
                    serverSelectionActiveTargetId: null,
                },
            });

            React.useEffect(() => {
                captured.push(value);
            }, [value]);

            return null;
        }

        await renderScreen(<IdentityProbe />);

        const latest = captured.at(-1);
        expect(latest.visibleMachineGroups).toEqual([
            expect.objectContaining({
                serverId: 'srv_identity_active',
                serverName: 'Server A',
                status: 'idle',
                machines: [expect.objectContaining({ id: 'm-identity' })],
            }),
        ]);
    });

    it('names each Home through the Home label owner, never offering its address as a name', async () => {
        const captured: any[] = [];
        await renderScreen(<Probe
            allMachines={[]}
            serverProfiles={[{
                id: 'server-a',
                name: 'a.example.test',
                serverUrl: 'https://a.example.test',
                personalHomeBootstrapCompleted: true,
                lastUsedAt: 1,
            }]}
            onValue={(value) => captured.push(value)}
        />);

        expect(captured.at(-1).visibleMachineGroups[0].serverName).not.toBe('a.example.test');
    });
});
