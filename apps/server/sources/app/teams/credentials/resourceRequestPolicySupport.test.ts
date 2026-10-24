import { afterEach, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { TeamCredentialSourceBindingV1Schema } from "@happier-dev/protocol/teams/credentials/sourceBindingV1";

import { resolveTeamCredentialRequestPolicySupport } from "./resourceRequestPolicySupport";

const findPool = vi.hoisted(() => vi.fn());
// SQLite composition remains in resourceRoutes.sqlite.integration.spec.ts.
// Only database IO is replaced here; the real Pool owner reads its projection.
vi.mock("@/storage/db", async importOriginal => ({
    ...await importOriginal<typeof import("@/storage/db")>(),
    db: { machinePool: { findFirst: findPool } },
}));
afterEach(() => vi.clearAllMocks());

it("does not promote one Pool member's application refusal over another member's model refusal", async () => {
    const accountId = "custodian";
    const machineIds = ["first", "second"];
    findPool.mockResolvedValue({
        id: "pool", accountId, name: "Policy brokers", description: null, revision: 0,
        createdAt: new Date(0), updatedAt: new Date(0),
        members: machineIds.map(machineId => ({ machineId, priorityTier: 0, enabled: true,
            machine: { accountId, kind: "persistent", revokedAt: null, replacedByMachineId: null,
                operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } },
                operationProtocolCapabilitiesRevision: 1 },
        })),
    });
    const source = TeamCredentialSourceBindingV1Schema.parse({
        v: 1, kind: "provider_connection", connectionId: "policy-connection",
        connectionSecurityFingerprint: `connection-security:v1:${"c".repeat(43)}`, credentialSlotId: "apiKey",
    });
    if (source.kind !== "provider_connection") throw new Error("Expected Provider source fixture");
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    // Network boundaries; Pool selection, schemas and refusal logic stay real.
    app.machineDaemonPresence = { in: () => ({ fetchSockets: async () => machineIds.map(machineId => ({
        data: { clientType: "machine-scoped", userId: accountId, machineId },
    })) }) };
    app.forwardRpcForUser = async input => ({ ok: true, result: {
        status: "unavailable", reason: input.method.startsWith(`${machineIds[0]}:`)
            ? "application_unavailable" : "model_unavailable",
    } });
    try {
        expect(await resolveTeamCredentialRequestPolicySupport(app, {
            ok: true, teamId: "team", custodianAccountId: accountId, source,
            brokerPlacement: { kind: "machine_pool", poolId: "pool" },
            sourceCurrentness: { kind: "provider_connection", connectionId: source.connectionId,
                connectionSecurityFingerprint: source.connectionSecurityFingerprint, credentialSlotId: source.credentialSlotId },
        })).toEqual({ status: "unavailable", reason: "broker_unavailable" });
    } finally { await app.close(); }
});
