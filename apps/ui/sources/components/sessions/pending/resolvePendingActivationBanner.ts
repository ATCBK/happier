import type { PendingActivationAuthorizationV1 } from '@happier-dev/protocol';

import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import type { ManagedWakeProjection } from '@/sync/domains/pending/managedWakeProjection';

export type PendingActivationBannerPresentation = Readonly<{
    kind: 'waiting_offline' | 'waiting' | 'failed' | 'queued' | 'queued_offline';
    row: PendingMessage | null;
    primaryAction: 'retry' | 'resume' | 'process_when_online' | null;
    secondaryAction: 'keep_queued' | null;
    settingsAction: 'settings';
    managedWakeProjection?: ManagedWakeProjection;
    holdReason?: PendingMessage['pendingActivationHoldReason'];
    titleKey?: 'managedWake.refused';
}>;

function isEligiblePendingUserRow(message: PendingMessage): boolean {
    if (message.localId == null || message.messageRole !== 'user') return false;
    if (message.pendingRequestedActionMalformed === true) return false;
    if (message.pendingOutboxOperation === 'cancel') return false;
    if (
        message.pendingDeliveryStatus === 'blocked'
        || message.pendingDeliveryStatus === 'server_delivering'
        || message.deliveryStatus === 'accepted'
    ) return false;
    return message.pendingDeliveryStatus === 'server_queued'
        || message.deliveryStatus === 'queued';
}

function comparePendingRows(left: PendingMessage, right: PendingMessage): number {
    if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
    return (left.localId ?? left.id).localeCompare(right.localId ?? right.id);
}

export function resolvePendingActivationBanner(input: Readonly<{
    authorization?: PendingActivationAuthorizationV1 | null;
    activeAt: number;
    active: boolean;
    machineReachable: boolean;
    canWrite: boolean;
    resumingAt?: number | null;
    pendingMessages: readonly PendingMessage[];
    managedWakeProjection?: ManagedWakeProjection | null;
}>): PendingActivationBannerPresentation | null {
    if (!input.canWrite) return null;
    const managedWakeProjection = input.managedWakeProjection;
    const rows = input.pendingMessages.filter(isEligiblePendingUserRow).sort(comparePendingRows);
    // Current refusal can outlive a retained target after a grant downgrade.
    // Actual native progress/loss still wins over an older queue diagnostic.
    const held = !input.machineReachable && input.resumingAt == null
        && (!managedWakeProjection || managedWakeProjection.kind === 'unknown' || managedWakeProjection.kind === 'waiting'
            || managedWakeProjection.kind === 'agentStartFailed' && managedWakeProjection.canRequestWake)
        ? rows.find(row => row.pendingActivationHoldReason) : undefined;
    if (held) return {
        kind: 'queued_offline', row: held, holdReason: held.pendingActivationHoldReason,
        ...(held.pendingActivationHoldReason === 'managed_power_required' ? { titleKey: 'managedWake.refused' as const } : {}),
        primaryAction: held.pendingActivationHoldReason === 'managed_power_required' ? null : 'process_when_online',
        secondaryAction: null, settingsAction: 'settings',
    };
    if (managedWakeProjection) {
        // The managed badge owns observed native stages, including runtime resume,
        // absence and uncertain custody; the generic banner must not reinterpret them.
        const row = input.pendingMessages.filter(isEligiblePendingUserRow)
            .find(candidate => candidate.localId === input.authorization?.requestId) ?? null;
        return {
            kind: managedWakeProjection.kind === 'agentStartFailed' ? 'failed' : input.machineReachable ? 'waiting' : 'waiting_offline',
            managedWakeProjection, row,
            primaryAction: row && managedWakeProjection.canRetryAgentStart ? 'retry'
                : row && managedWakeProjection.canResumeRuntime ? 'resume'
                    : row && managedWakeProjection.canRequestWake ? 'process_when_online' : null,
            secondaryAction: null,
            settingsAction: 'settings',
        };
    }
    if (input.resumingAt != null) return null;
    if (input.active && input.machineReachable) return null;
    const authorization = input.authorization && input.authorization.requestedAt > input.activeAt
        ? input.authorization
        : null;
    if (authorization) {
        const row = rows.find((candidate) => candidate.localId === authorization.requestId) ?? null;
        if (authorization.status === 'failed') {
            return {
                kind: 'failed',
                row,
                primaryAction: row
                    ? (input.machineReachable ? 'retry' : 'process_when_online')
                    : null,
                secondaryAction: row ? 'keep_queued' : null,
                settingsAction: 'settings',
            };
        }
        return {
            kind: input.machineReachable ? 'waiting' : 'waiting_offline',
            row,
            primaryAction: null,
            secondaryAction: row ? 'keep_queued' : null,
            settingsAction: 'settings',
        };
    }
    if (rows.length === 0) return null;
    return {
        kind: input.machineReachable ? 'queued' : 'queued_offline',
        row: rows[0],
        primaryAction: input.machineReachable ? 'resume' : 'process_when_online',
        secondaryAction: null,
        settingsAction: 'settings',
    };
}
