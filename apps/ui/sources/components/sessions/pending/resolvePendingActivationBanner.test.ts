import { describe, expect, it } from 'vitest';

import { resolvePendingActivationBanner } from './resolvePendingActivationBanner';
import { deriveManagedWakeProjection } from '@/sync/domains/pending/managedWakeProjection';
import { PendingActivationAuthorizationV1Schema } from '@happier-dev/protocol/sessions/pending/pendingActivationAuthorizationV1';

const waiting = { requestId: 'p2', requestedAt: 200, status: 'waiting' as const };
const failed = { requestId: 'p2', requestedAt: 200, status: 'failed' as const, failureCode: 'runtime_start_failed' as const };
const rows = [
    { id: '1', localId: 'p1', createdAt: 10, updatedAt: 10, text: 'one', rawRecord: {}, messageRole: 'user' as const, pendingDeliveryStatus: 'server_queued' as const, pendingRequestedAction: { v: 1 as const, kind: 'enqueue' as const } },
    { id: '2', localId: 'p2', createdAt: 20, updatedAt: 20, text: 'two', rawRecord: {}, messageRole: 'user' as const, pendingDeliveryStatus: 'server_queued' as const, pendingRequestedAction: { v: 1 as const, kind: 'send_now' as const } },
];

describe('resolvePendingActivationBanner', () => {
    it('keeps a person-held queue behind explicit Resume, including stale waiting activation', () => {
        const input = { activeAt: 100, active: false, machineReachable: true, canWrite: true,
            pendingMessages: rows, authorization: waiting, autoResumeAdmission: 'held_by_person' as const };
        expect(resolvePendingActivationBanner(input)).toMatchObject({ kind: 'held', row: rows[0], primaryAction: 'resume' });
        expect(resolvePendingActivationBanner({ ...input, machineReachable: false }))
            .toMatchObject({ kind: 'held', primaryAction: null });
        expect(resolvePendingActivationBanner({ ...input, canWrite: false })).toBeNull();
        expect(resolvePendingActivationBanner({ ...input, active: true })).toBeNull();
        expect(resolvePendingActivationBanner({ ...input, resumingAt: 300 })).toBeNull();
        expect(resolvePendingActivationBanner({ ...input, pendingMessages: [], authorization: null })).toBeNull();
        expect(resolvePendingActivationBanner({ ...input, autoResumeAdmission: 'archived' }))
            .toMatchObject({ kind: 'waiting', primaryAction: null });
    });
    it('keeps unknown Machine queues generic and closed until observed reachability returns', () => {
        const input = { activeAt: 100, active: false, machineReachable: null, canWrite: true, pendingMessages: rows };
        expect(resolvePendingActivationBanner(input)).toMatchObject({ kind: 'queued', primaryAction: null });
        expect(resolvePendingActivationBanner({ ...input, authorization: waiting })).toMatchObject({ kind: 'waiting', primaryAction: null });
        expect(resolvePendingActivationBanner({ ...input, authorization: failed })).toMatchObject({ kind: 'failed', primaryAction: null });
        expect(resolvePendingActivationBanner({ ...input, pendingMessages: [{ ...rows[0], pendingActivationHoldReason: 'resume_not_requested' }] }))
            .toMatchObject({ kind: 'queued', primaryAction: null });
    });
    it.each(['runtime_start_failed', 'managed_start_denied'] as const)('rearms the same failed stopped wake and gives current power refusal precedence (%s)', failureCode => {
        const authorization = PendingActivationAuthorizationV1Schema.parse({ ...failed, failureCode });
        const managed = {
            id: 'managed-a', homeId: 'home-a', creationState: 'active' as const, allocation: 'bound' as const,
            wakeOnAcceptedMessage: true,
            enrolledMachineId: 'guest-a', controller: { machineId: 'controller-a', installationId: 'installation-a' },
            observation: { observedAt: 10, availability: 'present' as const, power: 'stopped' as const, storage: 'unknown' as const, daemon: 'disconnected' as const },
        };
        const row = { ...rows[1], source: 'server_pending' as const };
        const managedWakeProjection = deriveManagedWakeProjection({ managed, activation: authorization, pending: row, runtimeResuming: false });
        expect(managedWakeProjection).toMatchObject({ failureCode, canRequestWake: true });
        const input = { authorization, activeAt: 100, active: false, machineReachable: false,
            canWrite: true, pendingMessages: [row], managedWakeProjection };
        expect(resolvePendingActivationBanner(input)).toMatchObject({ kind: 'failed', row: { localId: 'p2' },
            primaryAction: 'process_when_online' });
        expect(resolvePendingActivationBanner({ ...input, pendingMessages: [{ ...row, pendingActivationHoldReason: 'resume_not_requested' }] }))
            .toMatchObject({ primaryAction: 'process_when_online', row: { localId: 'p2' } });
        expect(resolvePendingActivationBanner({ ...input, pendingMessages: [{ ...row, pendingActivationHoldReason: 'managed_power_required' }] }))
            .toMatchObject({ titleKey: 'managedWake.refused', primaryAction: null, holdReason: 'managed_power_required' });
        expect(resolvePendingActivationBanner({ ...input, pendingMessages: [{ ...row, pendingDeliveryStatus: 'server_delivering' }] }))
            .toMatchObject({ primaryAction: null, row: null });
    });
    it('lets observed awake compute retire an older power hold after Agent startup fails', () => {
        const managedWakeProjection = deriveManagedWakeProjection({
            managed: { id: 'managed-a', homeId: 'home-a', creationState: 'active', allocation: 'bound', enrolledMachineId: 'guest-a',
                wakeOnAcceptedMessage: true,
                controller: { machineId: 'controller-a', installationId: 'installation-a' },
                observation: { observedAt: 20, availability: 'present', power: 'running', storage: 'retained', daemon: 'connected' } },
            activation: failed, pending: { source: 'server_pending', pendingDeliveryStatus: 'server_queued' }, runtimeResuming: false,
        });
        expect(resolvePendingActivationBanner({ authorization: failed, activeAt: 100, active: false, machineReachable: false,
            canWrite: true, pendingMessages: [{ ...rows[1], pendingActivationHoldReason: 'managed_power_required' }], managedWakeProjection,
        })).toMatchObject({ kind: 'failed', primaryAction: 'retry', managedWakeProjection: { kind: 'agentStartFailed', canRequestWake: false } });
    });
    it('uses a current authorization and its exact request row', () => {
        expect(resolvePendingActivationBanner({ authorization: waiting, activeAt: 100, active: false, machineReachable: false, canWrite: true, pendingMessages: rows })).toMatchObject({ kind: 'waiting_offline', row: { localId: 'p2' } });
        expect(resolvePendingActivationBanner({ authorization: waiting, activeAt: 200, active: false, machineReachable: false, canWrite: true, pendingMessages: rows })).toMatchObject({ kind: 'queued_offline', row: { localId: 'p1' }, primaryAction: 'process_when_online' });
    });

    it('distinguishes an offline queue without durable activation authorization', () => {
        expect(resolvePendingActivationBanner({ authorization: null, activeAt: 100, active: false, machineReachable: false, canWrite: true, pendingMessages: rows })).toMatchObject({
            kind: 'queued_offline',
            row: { localId: 'p1' },
            primaryAction: 'process_when_online',
        });
    });

    it('presents reachable waiting, failed terminal, and queue-only states without initiating work', () => {
        expect(resolvePendingActivationBanner({ authorization: waiting, activeAt: 100, active: false, machineReachable: true, canWrite: true, pendingMessages: rows })).toMatchObject({ kind: 'waiting', row: { localId: 'p2' } });
        expect(resolvePendingActivationBanner({ authorization: failed, activeAt: 100, active: false, machineReachable: true, canWrite: true, pendingMessages: rows })).toMatchObject({ kind: 'failed', row: { localId: 'p2' }, primaryAction: 'retry' });
        expect(resolvePendingActivationBanner({ authorization: failed, activeAt: 100, active: false, machineReachable: false, canWrite: true, pendingMessages: rows })).toMatchObject({ kind: 'failed', row: { localId: 'p2' }, primaryAction: 'process_when_online' });
        expect(resolvePendingActivationBanner({ authorization: null, activeAt: 100, active: false, machineReachable: true, canWrite: true, pendingMessages: [...rows].reverse() })).toMatchObject({ kind: 'queued', row: { localId: 'p1' }, primaryAction: 'resume' });
    });

    it('suppresses waiting and failed authorization while active and reachable', () => {
        expect(resolvePendingActivationBanner({ authorization: waiting, activeAt: 100, active: true, machineReachable: true, canWrite: true, pendingMessages: rows })).toBeNull();
        expect(resolvePendingActivationBanner({ authorization: failed, activeAt: 100, active: true, machineReachable: true, canWrite: true, pendingMessages: rows })).toBeNull();
    });

    it('retains waiting authorization while active but unreachable', () => {
        expect(resolvePendingActivationBanner({ authorization: waiting, activeAt: 100, active: true, machineReachable: false, canWrite: true, pendingMessages: rows })).toMatchObject({ kind: 'waiting_offline', row: { localId: 'p2' } });
    });

    it('suppresses active-online, malformed, non-user, and read-only state', () => {
        expect(resolvePendingActivationBanner({ authorization: null, activeAt: 100, active: true, machineReachable: true, canWrite: true, pendingMessages: rows })).toBeNull();
        expect(resolvePendingActivationBanner({ authorization: null, activeAt: 100, active: false, machineReachable: false, canWrite: true, pendingMessages: [{ ...rows[0], pendingRequestedActionMalformed: true }] })).toBeNull();
        expect(resolvePendingActivationBanner({ authorization: null, activeAt: 100, active: false, machineReachable: false, canWrite: true, pendingMessages: [{ ...rows[0], messageRole: 'assistant' as any }] })).toBeNull();
        expect(resolvePendingActivationBanner({ authorization: waiting, activeAt: 100, active: false, machineReachable: false, canWrite: false, pendingMessages: rows })).toBeNull();
    });

    it('hides the activation banner while the session is already resuming', () => {
        expect(resolvePendingActivationBanner({ authorization: null, activeAt: 100, active: false, machineReachable: true, canWrite: true, resumingAt: 300, pendingMessages: rows })).toBeNull();
    });

    it('does not offer Agent retry before native prerequisites or label ambiguous delivery as safely queued', () => {
        const managed = {
            id: 'managed-a', homeId: 'home-a', creationState: 'active' as const, allocation: 'bound' as const,
            wakeOnAcceptedMessage: true,
            enrolledMachineId: 'guest-a', controller: { machineId: 'controller-a', installationId: 'installation-a' },
            observation: { observedAt: 10, availability: 'present' as const, power: 'stopped' as const, storage: 'retained' as const, daemon: 'disconnected' as const },
        };
        const managedWakeProjection = deriveManagedWakeProjection({
            managed, activation: failed, pending: { ...rows[1], source: 'server_pending' }, runtimeResuming: false,
        });
        expect(resolvePendingActivationBanner({
            authorization: failed, activeAt: 100, active: false, machineReachable: false, canWrite: true, pendingMessages: rows,
            ...{ managedWakeProjection },
        })).toMatchObject({ kind: 'failed', primaryAction: 'process_when_online', managedWakeProjection: { kind: 'agentStartFailed' } });
        const unknown = deriveManagedWakeProjection({
            managed, activation: failed, pending: { ...rows[1], source: 'server_pending', pendingDeliveryStatus: 'server_delivering' }, runtimeResuming: false,
        });
        expect(resolvePendingActivationBanner({
            authorization: failed, activeAt: 100, active: false, machineReachable: false, canWrite: true, pendingMessages: [],
            ...{ managedWakeProjection: unknown },
        })).toMatchObject({ managedWakeProjection: { kind: 'deliveryUnknown' }, primaryAction: null, secondaryAction: null });
    });
    it('keeps managed resuming and loss visible through the managed badge without a generic recovery action', () => {
        for (const kind of ['resuming', 'storageLost', 'resourceAbsent', 'unknown', 'unavailable'] as const) {
            expect(resolvePendingActivationBanner({ authorization: waiting, activeAt: 100, active: false, machineReachable: true,
                canWrite: true, resumingAt: 300, pendingMessages: rows,
                managedWakeProjection: { kind, inputCustody: 'queued', canWithdraw: true, canRetryAgentStart: false, canRequestWake: false, canResumeRuntime: false },
            })).toMatchObject({ managedWakeProjection: { kind }, primaryAction: null });
        }
    });
});
