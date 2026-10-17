import { t } from '@/text';
import { readMachineName as readPublishedMachineName, resolveMachineDisplayNameParts as resolvePublishedMachineNameParts, type MachineNameMetadata as PublishedMachineNameMetadata } from '@happier-dev/protocol/machines/machineDisplayNames';

/**
 * How the app names machines. `getMachineDisplayName` names one machine, optionally in its inventory;
 * `resolveMachineDisplayNames`
 * names a set shown together and tells same-named machines apart. Every list, picker and detail
 * title reads these, never its own `displayName || host || id`. A machine is never shown by its raw
 * id: without a name or host it is "Unnamed machine", a machine whose details cannot be read is
 * "Locked machine", a machine a list refers to but no longer holds is named by what happened to it
 * (`absence`), and the short id appears only as the suffix that tells such machines apart. Keys,
 * dedupe and agent-facing data use `readMachineName` with their own id fallback.
 */
type MachineNameMetadata = PublishedMachineNameMetadata | null;
type MachineNameAvailability = Readonly<{ kind: string; reason?: string }> | null;
/**
 * Why a referenced machine is not in the inventory: removed (revoked), replaced, a temporary
 * computer, or simply not listed here.
 */
export type MachineAbsence = 'removed' | 'replaced' | 'temporary' | 'unlisted';
type MachineNameInput = Readonly<{
    id?: string | null;
    metadata?: MachineNameMetadata;
    availability?: MachineNameAvailability;
    absence?: MachineAbsence | null;
}>;

const ABSENT_MACHINE_NAME_KEYS = {
    removed: 'machine.removedMachine',
    replaced: 'machine.replacedMachine',
    temporary: 'newSession.temporaryComputer.title',
    unlisted: 'machine.unlistedMachine',
} as const satisfies Record<MachineAbsence, string>;

const LOCKED_REASON_KEYS = {
    // Sync found no Account key material on this device to open the Machine's key.
    encryption_material_unavailable: 'machine.lockedReason.missingKey',
    // The Machine's key envelope is present but this device could not open it.
    decryption_failed: 'machine.lockedReason.unopenable',
    // A plaintext Machine whose content could not be parsed.
    content_unreadable: 'machine.lockedReason.unreadable',
    recipient_key_pending: 'machines.destinations.pendingKey',
    recipient_access_refused: 'common.unavailable',
} as const;

/**
 * A machine whose details this device cannot read: sync explicitly projects a locked availability
 * state. `metadata: null` alone is also used while encrypted metadata is still hydrating.
 */
function isMachineLocked(machine: MachineNameInput): boolean {
    return machine.availability?.kind === 'locked';
}

export function isMachineDisplayHydrating(machine: MachineNameInput): boolean {
    return machine.metadata === null && machine.availability === undefined;
}

/**
 * Why this device cannot read a locked machine, as the row's reason line; `null` for a readable one.
 * The wording follows the reason sync recorded when it locked the Machine.
 */
export function describeMachineLockedReason(machine: MachineNameInput | null | undefined): string | null {
    if (!machine || machine.absence || !isMachineLocked(machine)) return null;
    const reason = machine.availability?.reason;
    const key = reason && reason in LOCKED_REASON_KEYS
        ? LOCKED_REASON_KEYS[reason as keyof typeof LOCKED_REASON_KEYS]
        : LOCKED_REASON_KEYS.content_unreadable;
    return t(key);
}

/** The name a person gave the machine, else its host; `null` when it has neither or is locked. */
export function readMachineName(machine: MachineNameInput | null | undefined): string | null {
    if (machine && (machine.absence || isMachineLocked(machine))) return null;
    return readPublishedMachineName(machine?.metadata);
}

/** What a machine whose details cannot be read is called on screen. */
export function lockedMachineName(): string {
    return t('machine.lockedMachine');
}

/** What an unnamed machine is called on screen. */
export function unnamedMachineName(): string {
    return t('machine.unnamedMachine');
}

export function getMachineDisplayName(machine: MachineNameInput, inventory?: readonly MachineNameSource[]): string;
export function getMachineDisplayName(machine: MachineNameInput | null | undefined, inventory?: readonly MachineNameSource[]): string | null;
export function getMachineDisplayName(machine: MachineNameInput | null | undefined, inventory?: readonly MachineNameSource[]): string | null {
    if (!machine) return null;
    if (machine.absence) return t(ABSENT_MACHINE_NAME_KEYS[machine.absence]);
    if (isMachineLocked(machine)) return lockedMachineName();
    if (isMachineDisplayHydrating(machine)) return t('common.loading');
    // A selected chip keeps the same identity as the list it opens. The list's resolver owns
    // disambiguation; callers supply its Home inventory rather than reimplementing suffix rules.
    if (inventory && machine.id) {
        const name = resolveMachineDisplayNames(inventory).get(machine.id);
        if (name !== undefined) return name;
    }
    return readMachineName(machine) ?? unnamedMachineName();
}

type MachineNameSource = MachineNameInput & Readonly<{ id: string }>;

/**
 * The names of machines shown together (a list, a picker, the home hub): each machine's
 * `getMachineDisplayName`, and only where two share a name (ignoring case, unnamed machines
 * included), a suffix that tells them apart: the host when it differs from the name and is unique
 * among them, else the shortest unique prefix of the machine id. Presence is not used: it changes,
 * and a name must stay stable.
 */
export function resolveMachineDisplayNames(machines: readonly MachineNameSource[]): ReadonlyMap<string, string> {
    return new Map([...resolveMachineDisplayNameParts(machines)].map(([id, parts]) => [id, parts.hint ? `${parts.name} · ${parts.hint}` : parts.name]));
}

/**
 * The same names as {@link resolveMachineDisplayNames}, kept in their two parts: the machine's own
 * name and the suffix that tells it apart (`null` when its name is already unique). A one-line row
 * shortens the name and keeps the suffix whole.
 */
export function resolveMachineDisplayNameParts(machines: readonly MachineNameSource[]): ReadonlyMap<string, Readonly<{ name: string; hint: string | null }>> {
    return resolvePublishedMachineNameParts(machines.map(machine => ({
        id: machine.id, name: getMachineDisplayName(machine),
        host: machine.absence || isMachineLocked(machine) ? null : machine.metadata?.host,
        disambiguate: !isMachineDisplayHydrating(machine),
    })));
}
