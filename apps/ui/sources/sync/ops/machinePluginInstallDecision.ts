import {
    HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD,
    HostPrivatePluginInstallDecisionV1Schema,
    type HostPrivatePluginInstallDecisionV1,
    type PluginChangePendingReviewResult,
} from '@happier-dev/protocol/marketplace/internal';
import { isRpcMethodNotFoundResult } from '@happier-dev/protocol/rpc';

import { decideMachinePluginInstallReviewAsPresentUser } from '@/sync/ops/machinePluginInstallPresentUserDecision.mjs';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { t } from '@/text';

type PositiveDecision = Omit<
    Extract<HostPrivatePluginInstallDecisionV1, Readonly<{ decision: 'installAndTrust' }>>,
    'v' | 'optionalSelections'
> & Readonly<{
    confirmPresentUser: () => Promise<
        readonly Readonly<{ accessId: string; selected: boolean }>[] | null
    >;
}>;
type CancelDecision = Omit<
    Extract<HostPrivatePluginInstallDecisionV1, Readonly<{ decision: 'cancel' }>>,
    'v'
>;

export type MachinePluginInstallDecisionInput =
    | PositiveDecision
    | CancelDecision;

export type MachinePluginInstallDecisionOutcome = Readonly<{
    kind:
        | 'committed'
        | 'failed'
        | 'conflict'
        | 'expired'
        | 'cancelled'
        | 'unavailable'
        | 'outcomeUnknown'
        | 'busy'
        | 'projectTrustAccepted'
        | 'reviewRequired';
    detail: string | null;
    /**
     * The daemon's own committed receipt or follow-up authority decision.
     * Preserve generation/pending-surface facts and let the canonical change
     * reader consume a renewed review rather than re-modelling either here.
     * Other terminal outcomes stay a bare `{ kind, detail }` result.
     */
    change?: unknown;
}>;

export type MachinePluginInstallDecisionResult =
    | Readonly<{ supported: true; outcome: MachinePluginInstallDecisionOutcome }>
    | Readonly<{ supported: false; reason: 'not-supported' | 'error'; detail: string | null }>;

/** One human review owner for mounted Actions and already-prepared daemon changes. */
export async function reviewMachinePluginInstallationAsPresentUser(
    machineId: string,
    opts: Readonly<{
        serverId: string;
        isAuthorityCurrent: () => boolean;
        installationReview: Pick<Extract<PluginChangePendingReviewResult, Readonly<{ reviewKind: 'installation' }>>,
            'pendingChangeId' | 'reason' | 'currentVersion' | 'authorityExpansion' | 'review'>;
        target: Readonly<{ machine: string; server: string }>;
    }>,
): Promise<MachinePluginInstallDecisionResult> {
    const pending = opts.installationReview;
    return await machinePluginInstallDecision(machineId, {
        serverId: opts.serverId,
        timeoutMs: null,
        isAuthorityCurrent: opts.isAuthorityCurrent,
        decision: {
            pendingChangeId: pending.pendingChangeId,
            decision: 'installAndTrust',
            confirmPresentUser: async () => {
                if (!opts.isAuthorityCurrent()) return null;
                const { showPluginInstallationReviewDialog } = await import('@/components/settings/plugins/PluginInstallationReviewDialog');
                if (!opts.isAuthorityCurrent()) return null;
                const resolution = await showPluginInstallationReviewDialog({
                    title: t('settingsPlugins.marketplaceInstallReviewTitle', {
                        name: pending.review.displayName, version: pending.review.version,
                    }),
                    review: pending.review,
                    reason: pending.reason,
                    currentVersion: pending.currentVersion,
                    authorityExpansion: pending.authorityExpansion,
                    target: opts.target,
                });
                return resolution.approved ? resolution.optionalSelections : null;
            },
        },
    });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function readErrorDetail(value: unknown): string | null {
    if (value instanceof Error) return readNonEmptyString(value.message);
    if (!isRecord(value)) return readNonEmptyString(value);
    return readNonEmptyString(value.message) ?? readNonEmptyString(value.code);
}

function parseOutcome(value: unknown): MachinePluginInstallDecisionOutcome | null {
    if (!isRecord(value)) return null;
    const kind = value.kind;
    if (
        kind !== 'committed'
        && kind !== 'failed'
        && kind !== 'conflict'
        && kind !== 'expired'
        && kind !== 'cancelled'
        && kind !== 'unavailable'
        && kind !== 'outcomeUnknown'
        && kind !== 'busy'
        && kind !== 'projectTrustAccepted'
        && kind !== 'reviewRequired'
    ) {
        return null;
    }
    const detail = readNonEmptyString(value.message) ?? readNonEmptyString(value.code);
    return kind === 'reviewRequired' || kind === 'committed' ? { kind, detail, change: value } : { kind, detail };
}

export async function machinePluginInstallDecision(
    machineId: string,
    opts: Readonly<{
        serverId?: string | null;
        timeoutMs?: number | null;
        isAuthorityCurrent: () => boolean;
        decision: MachinePluginInstallDecisionInput;
    }>,
): Promise<MachinePluginInstallDecisionResult> {
    try {
        let rawPayload: unknown;
        const callAuthenticatedPrivateRpc = async (
            method: typeof HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD,
            payload: HostPrivatePluginInstallDecisionV1,
        ) => await machineRpcWithServerScope({
            machineId,
            serverId: opts.serverId ?? undefined,
            timeoutMs: opts.timeoutMs ?? undefined,
            ...(opts.timeoutMs === null ? { operationTimeoutMs: null } : {}),
            method,
            payload,
        });
        if (opts.decision.decision === 'installAndTrust') {
            const affirmativeDecision = opts.decision;
            const { confirmPresentUser, ...decision } = affirmativeDecision;
            rawPayload = await decideMachinePluginInstallReviewAsPresentUser({
                pendingChangeId: decision.pendingChangeId,
                confirmPresentUser,
                isAuthorityCurrent: opts.isAuthorityCurrent,
                callAuthenticatedPrivateRpc,
            });
        } else {
            if (!opts.isAuthorityCurrent()) {
                return { supported: false, reason: 'error', detail: 'Plugin installation authority changed before the decision was sent' };
            }
            rawPayload = { v: 1, ...opts.decision };
            const payload = HostPrivatePluginInstallDecisionV1Schema.parse(rawPayload);
            rawPayload = await machineRpcWithServerScope<unknown, typeof payload>({
                machineId,
                serverId: opts.serverId ?? undefined,
                timeoutMs: opts.timeoutMs ?? undefined,
                ...(opts.timeoutMs === null ? { operationTimeoutMs: null } : {}),
                method: HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD,
                payload,
            });
        }
        const response = rawPayload;
        if (isRpcMethodNotFoundResult(response)) {
            return { supported: false, reason: 'not-supported', detail: null };
        }
        const outcome = parseOutcome(response);
        return outcome
            ? { supported: true, outcome }
            : { supported: false, reason: 'error', detail: 'The daemon returned an invalid plugin installation decision response' };
    } catch (error) {
        return { supported: false, reason: 'error', detail: readErrorDetail(error) };
    }
}
