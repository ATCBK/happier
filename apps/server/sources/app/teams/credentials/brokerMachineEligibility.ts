import { MachineKindFromLegacyProjectionSchema, isPersistentMachine } from '@happier-dev/protocol/machines/machineKind';
import { readMachineIrohEndpointAuthorityV1, supportsMachineOperationProtocolCapabilityV1, type MachineIrohEndpointAuthorityV1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';

import { classifyMachineDaemonPresence, type MachineDaemonPresenceInventory } from "@/app/machines/machineDaemonPresence";
import { classifyMachineAvailabilityState } from "@/app/machines/machineStateGuards";
import type { Tx } from "@/storage/inTx";

interface TeamCredentialBrokerMachineTarget {
    readonly custodianAccountId: string;
    readonly brokerMachineId: string | null;
}

type TeamCredentialBrokerMachineProjection = Readonly<{
    kind: string;
    revokedAt: Date | null;
    replacedByMachineId: string | null;
    operationProtocolCapabilities: unknown;
    operationProtocolCapabilitiesRevision: number | null;
}>;

export function classifyTeamCredentialBrokerMachineEligibility(
    machine: TeamCredentialBrokerMachineProjection | null,
): "eligible" | "ineligible" | "update_required" {
    if (machine === null || classifyMachineAvailabilityState(machine) !== "available") return "ineligible";
    const kind = MachineKindFromLegacyProjectionSchema.safeParse(machine.kind);
    if (!kind.success || !isPersistentMachine({ kind: kind.data })) return "ineligible";
    if (!supportsMachineOperationProtocolCapabilityV1(machine.operationProtocolCapabilities, "providerBrokerIngress")) {
        return "update_required";
    }
    if (!Number.isInteger(machine.operationProtocolCapabilitiesRevision)
        || (machine.operationProtocolCapabilitiesRevision ?? 0) <= 0) {
        return "update_required";
    }
    return "eligible";
}

export type TeamCredentialBrokerMachineEligibilityError = Readonly<{
    ok: false;
    error: "broker_unavailable" | "update_required";
}>;

/** Server-private deciding checks, never part of a route response. */
export type TeamCredentialBrokerMachineRefusal =
    | Readonly<{
        ok: false;
        error: "broker_unavailable";
        refusalReason: "broker_machine_missing" | "broker_ineligible" | "broker_offline" | "broker_presence_unknown" | "placement_endpoint_missing";
    }>
    | Readonly<{ ok: false; error: "update_required" }>;

/** Current admitted Machine facts for consumers that also need its endpoint. */
export async function readEligibleBrokerMachineInTx(
    tx: Tx,
    target: TeamCredentialBrokerMachineTarget,
): Promise<Readonly<{
    ok: true;
    machine: TeamCredentialBrokerMachineProjection & Readonly<{ id: string }>;
}> | TeamCredentialBrokerMachineRefusal> {
    if (!target.brokerMachineId) return { ok: false, error: "broker_unavailable", refusalReason: "broker_machine_missing" };
    const machine = await tx.machine.findFirst({
        where: { id: target.brokerMachineId, accountId: target.custodianAccountId },
        select: {
            id: true,
            kind: true,
            revokedAt: true,
            replacedByMachineId: true,
            operationProtocolCapabilities: true,
            operationProtocolCapabilitiesRevision: true,
        },
    });
    if (machine === null) return { ok: false, error: "broker_unavailable", refusalReason: "broker_machine_missing" };
    const eligibility = classifyTeamCredentialBrokerMachineEligibility(machine);
    if (eligibility === "ineligible") {
        return { ok: false, error: "broker_unavailable", refusalReason: "broker_ineligible" };
    }
    if (eligibility === "update_required") {
        return { ok: false, error: "update_required" } as const;
    }
    return { ok: true, machine } as const;
}

/** Saved placement requires known compatibility, but an offline broker remains repairable. */
export async function resolveTeamCredentialBrokerMachineForSaveInTx(
    tx: Tx,
    target: TeamCredentialBrokerMachineTarget,
): Promise<Readonly<{ ok: true; machineId: string }> | TeamCredentialBrokerMachineEligibilityError> {
    const eligible = await readEligibleBrokerMachineInTx(tx, target);
    if (!eligible.ok) return { ok: false, error: eligible.error };
    return { ok: true, machineId: eligible.machine.id };
}

/**
 * Rechecks saved eligibility against current presence in the caller's authority transaction, and
 * reads whatever Iroh endpoint the Machine currently advertises. The caller obtains the canonical
 * Socket.IO presence inventory before entering the transaction; persisted active/lastActiveAt
 * fields are not live presence authority.
 *
 * A broker Machine reached over the Home's server relay (resource test, external API key) carries
 * no Iroh endpoint of its own, so the endpoint is a fact, not an eligibility condition here: only
 * a consumer that opens the private peer tunnel requires one.
 */
export async function resolveTeamCredentialBrokerMachinePresentInTx(
    tx: Tx,
    params: TeamCredentialBrokerMachineTarget & Readonly<{ presence: MachineDaemonPresenceInventory }>,
): Promise<Readonly<{
    ok: true;
    machineId: string;
    endpointAuthority: MachineIrohEndpointAuthorityV1 | null;
}> | TeamCredentialBrokerMachineRefusal> {
    const eligible = await readEligibleBrokerMachineInTx(tx, params);
    if (!eligible.ok) return eligible;
    const presence = classifyMachineDaemonPresence(params.presence, eligible.machine.id);
    if (presence !== 'connected') {
        return { ok: false, error: "broker_unavailable", refusalReason: presence === 'unknown' ? "broker_presence_unknown" : "broker_offline" };
    }
    return {
        ok: true,
        machineId: eligible.machine.id,
        endpointAuthority: readMachineIrohEndpointAuthorityV1({
            capabilities: eligible.machine.operationProtocolCapabilities,
            revision: eligible.machine.operationProtocolCapabilitiesRevision,
        }),
    };
}

/**
 * The present-eligible Machine plus the private-tunnel requirement: a broker open that carries its
 * own Iroh endpoint. Relay-reached consumers use `resolveTeamCredentialBrokerMachinePresentInTx`.
 */
export async function resolveTeamCredentialBrokerMachineForOpenInTx(
    tx: Tx,
    params: TeamCredentialBrokerMachineTarget & Readonly<{ presence: MachineDaemonPresenceInventory }>,
): Promise<Readonly<{
    ok: true;
    machineId: string;
    endpointAuthority: MachineIrohEndpointAuthorityV1;
}> | TeamCredentialBrokerMachineRefusal> {
    const present = await resolveTeamCredentialBrokerMachinePresentInTx(tx, params);
    if (!present.ok) return present;
    if (present.endpointAuthority === null) return { ok: false, error: "broker_unavailable", refusalReason: "placement_endpoint_missing" };
    return { ok: true, machineId: present.machineId, endpointAuthority: present.endpointAuthority };
}
