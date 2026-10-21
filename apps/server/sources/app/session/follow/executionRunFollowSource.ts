import { ExecutionRunFollowFrontierResponseSchema, type ExecutionRunFollowFrontierResponse } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { SessionInputMachineTargetV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { Fastify } from '@/app/api/types';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { readCurrentCommittedSessionInputMachineTargetInTx } from '@/app/session/messages/sessionInputAdmission';
import { inReadSnapshot, type Tx } from '@/storage/inTx';
import { canReadFollowSourceInTx } from './followSourceAdmission';
import { resolveExecutionRunFollowOccurrenceV1, deriveSessionFollowOriginalOccurrenceKeyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import type { SessionFollowPendingObservationV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';

export type ExecutionRunFollowFrontierWitness = Readonly<{
    source: Readonly<{ kind: 'execution_run'; sessionId: string; runId: string }>;
    status: ExecutionRunFollowFrontierResponse['status'];
    terminalEventId: string | null;
    attention?: ExecutionRunFollowFrontierResponse['attention'];
    target: SessionInputMachineTargetV1;
    publisherGeneration: string;
}>;

function sameTarget(left: SessionInputMachineTargetV1, right: SessionInputMachineTargetV1): boolean {
    return left.homeId === right.homeId && left.accountId === right.accountId && left.sessionId === right.sessionId
        && left.machineId === right.machineId && left.installationId === right.installationId;
}

/** Recheck the captured publisher and Machine target in the mutation/ACK transaction. */
export async function isExecutionRunFollowFrontierWitnessCurrentInTx(tx: Tx,
    witness: ExecutionRunFollowFrontierWitness): Promise<boolean> {
    const session = await tx.session.findUnique({ where: { id: witness.source.sessionId },
        select: { accountId: true, archivedAt: true, publisherGeneration: true } });
    if (!session || session.archivedAt !== null || session.accountId !== witness.target.accountId
        || session.publisherGeneration.toString() !== witness.publisherGeneration) return false;
    const current = await readCurrentCommittedSessionInputMachineTargetInTx(tx, witness.source.sessionId);
    return current !== undefined && sameTarget(current, witness.target);
}

/** One content-free retained Run read, shared by new-Follow seeding and original validation. */
export async function readCurrentExecutionRunFollowSource(input: Readonly<{
    app: Pick<Fastify, 'forwardRpcForUser'>;
    accountId: string;
    sessionId: string;
    runId: string;
    authentication: SessionAccessAuthentication;
}>): Promise<Readonly<{ ok: true; value: ExecutionRunFollowFrontierWitness }>
    | Readonly<{ ok: false; error: 'session_follow_source_unavailable' }>> {
    const source = { kind: 'execution_run' as const, sessionId: input.sessionId, runId: input.runId };
    const captured = await inReadSnapshot(async tx => {
        if (!await canReadFollowSourceInTx(tx, { accountId: input.accountId, source,
            authentication: input.authentication })) return null;
        const session = await tx.session.findUnique({ where: { id: input.sessionId },
            select: { accountId: true, archivedAt: true, publisherGeneration: true } });
        if (!session || session.archivedAt !== null) return null;
        const target = await readCurrentCommittedSessionInputMachineTargetInTx(tx, input.sessionId);
        return target && target.accountId === session.accountId
            ? { target, publisherGeneration: session.publisherGeneration.toString() } : null;
    });
    if (!captured) return { ok: false, error: 'session_follow_source_unavailable' };
    let rpc: Awaited<ReturnType<Fastify['forwardRpcForUser']>>;
    try {
        rpc = await input.app.forwardRpcForUser({ userId: captured.target.accountId,
            method: `${captured.target.machineId}:${SESSION_RPC_METHODS.EXECUTION_RUN_FOLLOW_FRONTIER}`,
            params: { sessionId: input.sessionId, runId: input.runId } });
    } catch {
        return { ok: false, error: 'session_follow_source_unavailable' };
    }
    if (!rpc.ok) return { ok: false, error: 'session_follow_source_unavailable' };
    const parsed = ExecutionRunFollowFrontierResponseSchema.safeParse(rpc.result);
    if (!parsed.success || parsed.data.sessionId !== input.sessionId || parsed.data.runId !== input.runId)
        return { ok: false, error: 'session_follow_source_unavailable' };
    const witness: ExecutionRunFollowFrontierWitness = { source, status: parsed.data.status,
        terminalEventId: parsed.data.terminalEventId,
        ...(parsed.data.attention ? { attention: parsed.data.attention } : {}),
        target: captured.target, publisherGeneration: captured.publisherGeneration };
    if (!await inReadSnapshot(tx => isExecutionRunFollowFrontierWitnessCurrentInTx(tx, witness)))
        return { ok: false, error: 'session_follow_source_unavailable' };
    return { ok: true, value: witness };
}

/** Mutable permission originals are re-read outside the storage transaction before native dispatch. */
export async function retainCurrentExecutionRunFollowObservations(input: Readonly<{
    app: Pick<Fastify, 'forwardRpcForUser'>; accountId: string; authentication: SessionAccessAuthentication;
    observations: readonly SessionFollowPendingObservationV1[];
}>): Promise<SessionFollowPendingObservationV1[]> {
    const reads = new Map<string, ReturnType<typeof readCurrentExecutionRunFollowSource>>();
    const retained = await Promise.all(input.observations.map(async observation => {
        if (!('kind' in observation) || observation.kind !== 'admitted_run_input'
            || !('permissionRequests' in observation.delivery.original)) return observation;
        const original = observation.delivery.original;
        const source = original.source;
        const key = JSON.stringify(source);
        let read = reads.get(key);
        if (!read) {
            read = readCurrentExecutionRunFollowSource({ ...input, sessionId: source.sessionId, runId: source.runId });
            reads.set(key, read);
        }
        const frontier = await read;
        if (!frontier.ok || frontier.value.status === 'running' && frontier.value.attention
            && !frontier.value.attention.requests) return null;
        const current = resolveExecutionRunFollowOccurrenceV1({ ...frontier.value,
            sessionId: source.sessionId, runId: source.runId });
        return current && deriveSessionFollowOriginalOccurrenceKeyV1(current.original)
            === deriveSessionFollowOriginalOccurrenceKeyV1(original) ? observation : { ...observation, disposition: 'withdrawn' as const };
    }));
    return retained.filter((observation): observation is SessionFollowPendingObservationV1 => observation !== null);
}
