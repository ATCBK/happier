import { describe, expect, it } from "vitest";

import { getSocketRooms } from "@/app/api/socketRooms";

import { classifyMachineDaemonPresence, getMachineDaemonPresenceInventory, readMachineDaemonSocketIdentity } from "./machineDaemonPresence";

describe("exact Machine socket identity and inventory", () => {
    it('reads only the demanded daemon identities in a large Account', async () => {
        const sockets = Array.from({ length: 1_002 }, (_, index) => {
            const data = { userId: 'alice', clientType: 'machine-scoped' as const, machineId: `machine-${index}` };
            return { data, rooms: getSocketRooms(data) };
        });
        const transported: string[] = [];
        const io = { in: (room: string | string[]) => ({ fetchSockets: async () => {
            const rooms = Array.isArray(room) ? room : [room];
            const result = sockets.filter(socket => socket.rooms.some(value => rooms.includes(value)));
            transported.push(...result.map(socket => socket.data.machineId));
            return result;
        } }) };
        const inventory = await getMachineDaemonPresenceInventory({ accountId: 'alice', io,
            machineIds: ['machine-0', 'machine-1', 'machine-0'] });
        expect(transported).toEqual(['machine-0', 'machine-1']);
        expect(inventory.state !== 'unavailable' && [...inventory.machineIds]).toEqual(['machine-0', 'machine-1']);
        expect(classifyMachineDaemonPresence(inventory, 'machine-999')).toBe('unknown');
    });

    it('keeps empty exact demand local and excludes an ephemeral runner from ordinary daemon presence', async () => {
        const io = { in: () => ({ fetchSockets: async () => [{ data: {
            userId: 'alice', clientType: 'machine-scoped', machineId: 'runner',
            ephemeralRunnerAdmission: { kind: 'machine-runtime' },
        } }] }) };
        expect(classifyMachineDaemonPresence(await getMachineDaemonPresenceInventory({
            accountId: 'alice', io, machineIds: ['runner'],
        }), 'runner')).toBe('disconnected');
        const empty = await getMachineDaemonPresenceInventory({ accountId: 'alice', machineIds: [],
            io: { in: () => { throw new Error('Empty demand must not reach the adapter'); } } });
        expect(classifyMachineDaemonPresence(empty, 'runner')).toBe('unknown');
    });

    it('uses partial presence only for the observed Machine, preserving unknown versus disconnected', () => {
        const partial = { state: 'partial' as const, machineIds: new Set(['machine-a']) };
        expect(classifyMachineDaemonPresence(partial, 'machine-a')).toBe('connected');
        expect(classifyMachineDaemonPresence(partial, 'machine-b')).toBe('unknown');
        expect(classifyMachineDaemonPresence({ state: 'known', machineIds: partial.machineIds }, 'machine-b'))
            .toBe('disconnected');
        expect(classifyMachineDaemonPresence({ state: 'unavailable' }, 'machine-a')).toBe('unknown');
    });
    it("accepts ordinary machine sockets without reserved installation proof", () => {
        expect(readMachineDaemonSocketIdentity({ userId: "alice", clientType: "machine-scoped", machineId: "machine-a" }))
            .toEqual({ accountId: "alice", machineId: "machine-a" });
        expect(readMachineDaemonSocketIdentity({ userId: "alice", clientType: "session-scoped", machineId: "machine-a" })).toBeNull();
        expect(readMachineDaemonSocketIdentity({ userId: "alice", clientType: "user-scoped", machineId: "machine-a" })).toBeNull();
    });

    it("discovers joined Machine daemons but excludes ephemeral machine-runtime sockets", async () => {
        const daemon = { userId: "alice", clientType: "machine-scoped", machineId: "machine-a" } as const;
        const ephemeral = { userId: "alice", clientType: "machine-scoped", machineId: "machine-runtime" } as const;
        const sockets = [
            { data: daemon, rooms: getSocketRooms(daemon) },
            { data: ephemeral, rooms: getSocketRooms({ ...ephemeral, includeUserMachinesRoom: false }) },
        ];
        // Model only the Socket.IO adapter: membership comes from the real room producer.
        const io = { in: (room: string) => ({
            fetchSockets: async () => sockets.filter(socket => socket.rooms.includes(room)),
        }) };

        expect(await getMachineDaemonPresenceInventory({ accountId: "alice", io }))
            .toEqual({ state: "known", machineIds: new Set(["machine-a"]) });
    });

    it("collapses duplicates and excludes foreign and non-machine sockets", async () => {
        const sockets = [
            { data: { userId: "alice", clientType: "machine-scoped", machineId: "machine-a" } },
            { data: { userId: "alice", clientType: "machine-scoped", machineId: "machine-a" } },
            { data: { userId: "bob", clientType: "machine-scoped", machineId: "machine-b" } },
            { data: { userId: "alice", clientType: "session-scoped", machineId: "machine-c" } },
        ];
        const io = { in: (room: string) => {
            expect(room).toBe("user-machines:alice");
            return { fetchSockets: async () => sockets };
        } };
        expect(await getMachineDaemonPresenceInventory({ accountId: "alice", io }))
            .toEqual({ state: "known", machineIds: new Set(["machine-a"]) });
    });

    it("distinguishes an unavailable inventory from a known empty room", async () => {
        expect(await getMachineDaemonPresenceInventory({ accountId: "alice", io: {
            in: () => ({ fetchSockets: async () => { throw new Error("adapter unavailable"); } }),
        } })).toEqual({ state: "unavailable" });
        expect(await getMachineDaemonPresenceInventory({ accountId: "alice", io: {
            in: () => ({ fetchSockets: async () => [] }),
        } })).toEqual({ state: "known", machineIds: new Set() });
    });
});
