import { resolveTeamWorkosConnectionRuntimeInTx } from "@/app/auth/providers/workos/teamWorkosConnectionRuntime";
import { resolveWorkosPlatformRequestPolicy } from "@/app/integrations/workos/workosPlatform";
import { inTx } from "@/storage/inTx";
import type { DirectoryProjectionScanFailureCode } from "./directoryReconciler";
import { parseTeamDirectoryBindingConfigV1 } from "./directorySourceBinding";
import type { ActiveWorkosDirectorySource, ClaimedDirectorySource } from "./directorySourceService";
import type { ExpectedDirectorySourceCurrentness } from "./directorySourcePolicy";
import type { WorkosDirectoryReadContext } from "./workosDirectoryReader";

export type BeginWorkosDirectoryReadResult =
    | Readonly<{
        ok: true;
        context: WorkosDirectoryReadContext;
        expectedCurrentness: Extract<ExpectedDirectorySourceCurrentness, { kind: "workos_directory_read" }>;
    }>
    | Readonly<{ ok: false; code: DirectoryProjectionScanFailureCode }>;

/**
 * Resolve the exact current Team connection and immutable WorkOS organization
 * before any provider request. The connection runtime remains the sole owner
 * of provider documents, platform configuration, and credential identity.
 */
export async function beginWorkosDirectoryRead(params: Readonly<{
    source: ClaimedDirectorySource | ActiveWorkosDirectorySource;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
}>): Promise<BeginWorkosDirectoryReadResult> {
    const sourceBinding = params.source.binding;
    if (params.source.kind !== "workos_directory" || sourceBinding.kind !== "workos_directory") {
        return { ok: false, code: "directory_source_identity_mismatch" };
    }

    const resolved = await inTx(async (tx) => {
        const row = await tx.teamDirectorySource.findFirst({
            where: {
                id: params.source.id,
                teamId: params.source.teamId,
                kind: "workos_directory",
                ...(params.source.reconcileRunId === null
                    ? { state: "active" as const, activeReconcileRunId: null, manualSyncRequestedAt: null }
                    : { state: "initializing" as const, activeReconcileRunId: params.source.reconcileRunId }),
            },
            select: { bindingConfig: true, teamIdentityConnectionId: true },
        });
        if (!row?.teamIdentityConnectionId) return { status: "source_mismatch" as const };

        let binding: ReturnType<typeof parseTeamDirectoryBindingConfigV1>;
        try {
            binding = parseTeamDirectoryBindingConfigV1(row.bindingConfig);
        } catch {
            return { status: "source_mismatch" as const };
        }
        if (
            binding.kind !== "workos_directory"
            || binding.workosDirectoryId !== sourceBinding.workosDirectoryId
        ) return { status: "source_mismatch" as const };

        const directoryId = binding.workosDirectoryId;

        const runtime = await resolveTeamWorkosConnectionRuntimeInTx(tx, {
            env: params.env ?? process.env,
            teamId: params.source.teamId,
            connectionId: row.teamIdentityConnectionId,
            purpose: "directory",
            requestPolicy: resolveWorkosPlatformRequestPolicy(
                params.signal ? { signal: params.signal } : {},
            ),
        });
        return runtime.status === "ready"
            ? { status: "ready" as const, runtime, directoryId }
            : runtime;
    });

    if (resolved.status !== "ready") {
        switch (resolved.status) {
            case "platform_unavailable":
            case "not_configured":
                return { ok: false, code: "directory_sync_unavailable" };
            case "source_mismatch":
            case "connection_not_found":
            case "connection_disabled":
            case "connection_unavailable":
            case "provider_unavailable":
            case "unreadable":
                return { ok: false, code: "directory_source_identity_mismatch" };
        }
    }

    const { client } = resolved.runtime.platform;
    return {
        ok: true,
        expectedCurrentness: {
            kind: "workos_directory_read",
            directorySourceId: params.source.id,
            teamIdentityConnectionId: resolved.runtime.connection.id,
            workosDirectoryId: resolved.directoryId,
            organizationId: resolved.runtime.connection.externalReference.organizationId,
            runtimeFingerprint: resolved.runtime.runtimeFingerprint,
        },
        context: {
            organizationId: resolved.runtime.connection.externalReference.organizationId,
            directoryId: resolved.directoryId,
            listUsers: async (options) => await client.directorySync.listUsers(options),
            listGroups: async (options) => await client.directorySync.listGroups(options),
            listEvents: async (options) => await client.events.listEvents(options),
        },
    };
}
