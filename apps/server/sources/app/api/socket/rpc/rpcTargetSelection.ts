import type { RpcAckResponseEmitter, RpcTargetSelectionResult } from "./_types";
import type { SocketRpcAnsweringClientV1 } from '@happier-dev/protocol/socketRpc';

export function selectRpcTarget(params: Readonly<{
    targets: RpcAckResponseEmitter[];
    excludedSocketId?: string;
    answeringClient?: SocketRpcAnsweringClientV1;
}>): RpcTargetSelectionResult {
    const distinctTargets = [...params.targets].sort((left, right) => left.id.localeCompare(right.id));
    const nonCallerTargets =
        typeof params.excludedSocketId === "string" && params.excludedSocketId.length > 0
            ? distinctTargets.filter((target) => target.id !== params.excludedSocketId)
            : distinctTargets;
    const eligibleTargets = params.answeringClient?.clientId === undefined ? nonCallerTargets
        : nonCallerTargets.filter(target => target.id === params.answeringClient!.clientId);

    if (eligibleTargets.length === 0) {
        const callerWasPresent = typeof params.excludedSocketId === "string"
            && distinctTargets.some((target) => target.id === params.excludedSocketId);
        return callerWasPresent && !params.answeringClient?.clientId ? { type: "self-call" } : { type: "not-available" };
    }

    if (params.answeringClient?.requireSingle && eligibleTargets.length > 1) {
        return { type: 'ambiguous', clientIds: eligibleTargets.map(target => target.id) };
    }

    return {
        type: "target",
        target: eligibleTargets[0],
        hadMultipleTargets: !params.answeringClient?.clientId && (eligibleTargets.length > 1 || distinctTargets.length > 1),
        ...(params.answeringClient ? { clientIds: nonCallerTargets.map(target => target.id) } : {}),
    };
}
