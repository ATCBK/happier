import type { z } from 'zod/mini';
import type { MachineProcessesActionId, MACHINE_PROCESSES_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions/specs/machineProcesses';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { selectMachineProcessesLeftBehind } from './selectMachineProcessesLeftBehind';
import { MachineProcessesStartAgainResultV1Schema, type MachineProcessesStartAgainInputV1 } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import { executeLocalServiceLauncherStartWithReview, type LocalServiceLauncherStartReviewContext } from '@/components/sessions/localServices/launcherStartAction';
import { isLocalServiceActionAdmissionCurrent } from '@/components/sessions/localServices/localServiceActionAdmission';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

export type MachineProcessesActionScope = Readonly<{
    serverId: string; expectedAccountId: string; signal?: AbortSignal; actionRequestId?: string;
    /** Rich surface content is rendered only when the shared Action policy asks. */
    confirmation?: NonNullable<Parameters<typeof createFrontDoorActionExecute>[1]>['presentUserActionConfirmation'];
}>;
const execute = createFrontDoorActionExecute();

/** Preserve canonical success, failure and approval-Artifact outcomes for the mounted surface. */
export function executeMachineProcessesActionV1<Id extends MachineProcessesActionId>(actionId: Id,
    input: z.infer<(typeof MACHINE_PROCESSES_ACTION_INPUT_SCHEMAS)[Id]>, scope: MachineProcessesActionScope) {
    const { confirmation, ...context } = scope;
    const invoke = confirmation ? createFrontDoorActionExecute(undefined, { presentUserActionConfirmation: confirmation }) : execute;
    return invoke(actionId, input, { ...context, surface: 'ui' });
}

/** Cleanup echoes exactly the same filtered set used by its rendered count and memory total. */
export function executeMachineProcessesLeftBehindCleanUpV1(machineId: string,
    rows: Parameters<typeof selectMachineProcessesLeftBehind>[0], filter: Parameters<typeof selectMachineProcessesLeftBehind>[1],
    scope: MachineProcessesActionScope) {
    const selection = selectMachineProcessesLeftBehind(rows, filter);
    return executeMachineProcessesActionV1('machines.processes.leftBehind.cleanUp', { machineId, refs: selection.refs }, scope);
}

/** Native Service refusals continue through the existing launcher review and approval owner. */
export async function executeMachineProcessesStartAgainV1(input: MachineProcessesStartAgainInputV1, scope: MachineProcessesActionScope,
    reviewContext: Omit<LocalServiceLauncherStartReviewContext, 'serverId' | 'expectedAccountId'>) {
    const context = { ...reviewContext, ...scope, signal: scope.signal ?? reviewContext.signal };
    if (!isLocalServiceActionAdmissionCurrent(context)) {
        return { processAction: { ok: false as const, errorCode: 'cancelled', error: 'cancelled' } };
    }
    const processAction = await executeMachineProcessesActionV1('machines.processes.startAgain', input, context);
    if (!processAction.ok) return { processAction };
    const parsed = MachineProcessesStartAgainResultV1Schema.safeParse(processAction.result);
    const carrier = parsed.success ? parsed.data.serviceStart : undefined;
    if (!carrier || !isLocalServiceActionAdmissionCurrent(context)) return { processAction };
    const { request, response } = carrier;
    const target = response.snapshot.targets.find(target => target.id === request.targetId);
    if (request.machineId !== input.machineId || response.snapshot.machineId !== input.machineId || !target || target.machineId !== input.machineId
        || [request.workspace?.serverId, target.workspace?.serverId].some(serverId => serverId && !areServerProfileIdentifiersEquivalent(serverId, scope.serverId))) {
        return { processAction };
    }
    const serviceStartResponse = await executeLocalServiceLauncherStartWithReview({ request, target, initialResponse: response, context,
        ...(request.sessionId ? { defaultSessionId: request.sessionId } : {}) });
    return { processAction, serviceStartResponse };
}
