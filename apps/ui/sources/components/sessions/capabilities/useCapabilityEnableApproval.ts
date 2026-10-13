import * as React from 'react';
import type { ApprovalRequest } from '@happier-dev/protocol';
import { SessionCapabilitiesSetOutputV1Schema } from '@happier-dev/protocol/actions/specs/sessionCapabilities';
import type { ReachDecisionV1 } from '@happier-dev/protocol/reach/resolveReachV1';
import type { WhereItsOnNames } from '@/components/capabilities/where/whereItsOnPresentation';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useReachRules } from '@/sync/domains/capabilities/reach/useReachRules';
import { useApprovalDecisionHandler, useApprovalHome } from '@/components/tools/shell/approvals/useApprovalDecisionHandler';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { t } from '@/text';
import { createCapabilityEnableApprovalController, readCapabilityEnableApproval, resolveCapabilityAlwaysWrite } from './capabilityEnableApproval';

/** Per-Action body logic. The existing approval owner decides/replays; the present user writes Always. */
export function useCapabilityEnableApproval(input: Readonly<{
    artifact: Pick<DecryptedArtifact, 'id' | 'header'>; approval: ApprovalRequest; sessionId: string;
    decidedBy: ReachDecisionV1['decidedBy']; projectKey: string | null; machineId: string | null;
    itemTitle: string; agentName: string; names: WhereItsOnNames;
}>) {
    const request = readCapabilityEnableApproval(input.approval);
    const home = useApprovalHome(input.artifact, input.approval, input.sessionId);
    const decideApproval = useApprovalDecisionHandler(input.artifact, input.approval, input.sessionId);
    const decide = React.useCallback(async (decision: 'approve' | 'reject') => {
        let enabled = false;
        const recorded = await decideApproval(decision, { onExecution: receipt => {
            const result = receipt?.ok ? SessionCapabilitiesSetOutputV1Schema.safeParse(receipt.result) : null;
            enabled = result?.success === true && result.data.ok;
        } });
        return recorded && (decision === 'reject' || enabled);
    }, [decideApproval]);
    const execution = useMountedActionExecution(home.serverId);
    const scope = request && execution.ready ? execution.binding?.scope ?? null : null;
    const reach = useReachRules(request?.kind === 'skill' ? 'skill' : 'mcp_server', request?.id ?? '', scope);
    const alwaysWrite = request && reach.status === 'ready' ? resolveCapabilityAlwaysWrite({ decidedBy: input.decidedBy, rules: reach.rules,
        projectKey: input.projectKey, machineId: input.machineId }) : null;
    const key = JSON.stringify([input.artifact.id, scope?.serverId, scope?.accountId, execution.binding?.revision, request]);
    const latest = React.useRef({ alwaysWrite, key, decide, changeRules: reach.change, undoRules: reach.undoLast });
    latest.current = { alwaysWrite, key, decide, changeRules: reach.change, undoRules: reach.undoLast };
    const controller = React.useMemo(() => request ? createCapabilityEnableApprovalController({
        get alwaysWrite() { return latest.current.key === key ? latest.current.alwaysWrite : null; },
        decide: decision => latest.current.key === key ? latest.current.decide(decision) : Promise.resolve(false),
        changeRules: change => latest.current.key === key ? latest.current.changeRules(change)
            : Promise.resolve({ ok: false, message: 'scope-retired' }),
        undoRules: () => latest.current.key === key ? latest.current.undoRules()
            : Promise.resolve({ ok: false, message: 'scope-retired' }),
    }) : null, [key]);
    const subscribe = React.useCallback((listener: () => void) => controller?.subscribe(listener) ?? (() => {}), [controller]);
    const read = React.useCallback(() => controller?.getSnapshot() ?? null, [controller]);
    const state = React.useSyncExternalStore(subscribe, read, read);
    const chosenWrite = state?.alwaysWrite ?? alwaysWrite;
    const place = chosenWrite?.place;
    const placeName = place?.t === 'project' ? input.names.projectName(place.projectKey)
        : place?.t === 'machine' ? input.names.machineName(place.machineId)
        : place?.t === 'workspace' ? input.names.folderLabel(place.machineId, place.workspaceRoot) : null;
    const alwaysLabel = placeName && chosenWrite ? chosenWrite.agentId
        ? t('capabilities.session.alwaysFor', { agent: input.names.agentName(chosenWrite.agentId), place: placeName })
        : t('capabilities.session.always', { place: placeName }) : null;
    const undoSession = React.useCallback(async () => {
        const current = input.approval.execution;
        const parsed = current?.ok ? SessionCapabilitiesSetOutputV1Schema.safeParse(current.result) : null;
        if (!request || !parsed?.success || !parsed.data.ok) return { ok: false as const, error: 'nothing_to_undo' };
        return execution.execute('session.capabilities.set', { sessionId: request.sessionId, kind: request.kind, id: request.id, state: parsed.data.previous });
    }, [input.approval.execution, request, execution.execute]);
    return { request, state, ready: execution.ready, resolution: execution.resolution, rulesStatus: reach.status,
        serverId: home.serverId, alwaysWrite: chosenWrite, alwaysLabel,
        title: request ? t('capabilities.session.wants', { agent: input.agentName, item: input.itemTitle }) : null,
        reason: request?.reason ?? null, choose: controller?.choose, retryAlways: controller ? () => controller.choose('always') : undefined,
        undoAlways: controller?.undoAlways, undoSession };
}
