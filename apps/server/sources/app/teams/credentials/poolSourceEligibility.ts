import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { type ProviderBrokerOpenRequestV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { DaemonProviderTeamCredentialBrokerEligibilityResponseV1Schema } from '@happier-dev/protocol/rpc/providers';
import type { TeamCredentialSourceBindingV1 } from '@happier-dev/protocol/teams/credentials/sourceBindingV1';

/**
 * Asks each candidate Pool member whether it can currently run this source for
 * this exact application and model, or — for an external API key, whose
 * protocol and model are only known per request — for any application
 * (`scope: 'source_any'`). This is the one server-side reader for that
 * question: the placement owner ranks only members this reader retained, and
 * every ingress that can reach a Pool placement — external API, Session broker
 * open and the pre-Session Runner selection — uses it so a member is never
 * judged eligible by one path and ineligible by another.
 */
export type TeamCredentialPoolSourceEligibilityReader = (input: Readonly<{
    custodianAccountId: string;
    machineIds: readonly string[];
    teamId: string;
    resourceId: string;
    resourceRevision: number;
    source: TeamCredentialSourceBindingV1;
    signal: AbortSignal;
} & (
    | {
        application: ProviderBrokerOpenRequestV1["application"];
        modelId: string;
        sourceRevision: string;
    }
    | { scope: "source_any" }
)>) => Promise<Readonly<{
    eligibleMachineIds: ReadonlySet<string>;
    reasons: ReadonlyMap<string, string>;
}>>;

type RpcForwarder = (params: Readonly<{
    userId: string;
    method: string;
    params: unknown;
}>) => Promise<
    | Readonly<{ ok: true; result: unknown }>
    | Readonly<{ ok: false; error: string; errorCode?: string }>
>;

export function createTeamCredentialPoolSourceEligibilityReader(
    forwardRpcForUser: RpcForwarder,
): TeamCredentialPoolSourceEligibilityReader {
    return async (input) => {
        const entries = await Promise.all(input.machineIds.map(async (machineId) => {
            if (input.signal.aborted) return [machineId, "source_unavailable"] as const;
            const rpcResult = await forwardRpcForUser({
                userId: input.custodianAccountId,
                method: `${machineId}:${RPC_METHODS.DAEMON_PROVIDERS_TEAM_CREDENTIAL_BROKER_ELIGIBILITY}`,
                params: {
                    machineId,
                    teamId: input.teamId,
                    resourceId: input.resourceId,
                    expectedResourceRevision: input.resourceRevision,
                    source: input.source,
                    ...("scope" in input
                        ? { scope: input.scope }
                        : {
                            application: input.application,
                            modelId: input.modelId,
                            sourceRevision: input.sourceRevision,
                        }),
                },
            });
            if (!rpcResult.ok) return [machineId, "source_unavailable"] as const;
            const result = DaemonProviderTeamCredentialBrokerEligibilityResponseV1Schema.safeParse(rpcResult.result);
            if (!result.success) return [machineId, "source_unavailable"] as const;
            return result.data.status === "eligible"
                ? [machineId, null] as const
                : [machineId, result.data.reason] as const;
        }));
        return {
            eligibleMachineIds: new Set(entries.flatMap(([machineId, reason]) => reason === null ? [machineId] : [])),
            reasons: new Map(entries.flatMap(([machineId, reason]) => reason === null ? [] : [[machineId, reason] as const])),
        };
    };
}
