export type MachineNameMetadata = Readonly<{ displayName?: string | null; host?: string | null }>;

/** The authored name, else the host; presentation adapters own unreadable/unnamed placeholders. */
export function readMachineName(metadata: MachineNameMetadata | null | undefined): string | null {
    const displayName = typeof metadata?.displayName === 'string' ? metadata.displayName.trim() : '';
    const host = typeof metadata?.host === 'string' ? metadata.host.trim() : '';
    return displayName || host || null;
}

type MachineNameSource = Readonly<{
    id: string;
    name: string;
    host?: string | null;
    /** Loading text is not an identity and must not gain an id suffix. */
    disambiguate?: boolean;
}>;

const MACHINE_ID_HINT_MIN_LENGTH = 4;

function uniqueIdHint(id: string, others: readonly string[]): string {
    for (let length = Math.min(MACHINE_ID_HINT_MIN_LENGTH, id.length); length < id.length; length += 1) {
        const prefix = id.slice(0, length);
        if (others.every((other) => !other.startsWith(prefix))) return prefix;
    }
    return id;
}

/** Same-name machines use a distinct host, otherwise the shortest unique stable id prefix. */
export function resolveMachineDisplayNameParts(machines: readonly MachineNameSource[]): ReadonlyMap<string, Readonly<{ name: string; hint: string | null }>> {
    const idsByName = new Map<string, string[]>();
    for (const machine of machines) {
        const key = machine.name.toLocaleLowerCase();
        idsByName.set(key, [...(idsByName.get(key) ?? []), machine.id]);
    }
    const byId = new Map(machines.map((machine) => [machine.id, machine]));
    const names = new Map<string, Readonly<{ name: string; hint: string | null }>>();
    for (const machine of machines) {
        const collidingIds = idsByName.get(machine.name.toLocaleLowerCase()) ?? [];
        if (collidingIds.length < 2 || machine.disambiguate === false) {
            names.set(machine.id, { name: machine.name, hint: null });
            continue;
        }
        const others = collidingIds.filter((id) => id !== machine.id);
        const host = machine.host?.trim() ?? '';
        const hostDistinct = host.length > 0
            && host.toLocaleLowerCase() !== machine.name.toLocaleLowerCase()
            && others.every((id) => (byId.get(id)?.host?.trim() ?? '').toLocaleLowerCase() !== host.toLocaleLowerCase());
        names.set(machine.id, { name: machine.name, hint: hostDistinct ? host : uniqueIdHint(machine.id, others) });
    }
    return names;
}
