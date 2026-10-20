import * as React from 'react';
import type { ApprovalRequest } from '@happier-dev/protocol';
import { SessionCapabilitiesSetOutputV1Schema } from '@happier-dev/protocol/actions/specs/sessionCapabilities';
import type { ReachDecisionV1 } from '@happier-dev/protocol/reach/resolveReachV1';
import type { WhereItsOnNames } from '@/components/capabilities/where/whereItsOnPresentation';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useReachRulesCatalog } from '@/sync/store/useReachRulesCatalog';
import { createRequestOwnedActionExecution } from '@/components/approvals/requestOwnedActionExecution';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useApprovalDecisionHandler, useApprovalHome } from '@/components/tools/shell/approvals/useApprovalDecisionHandler';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { t } from '@/text';
import type { ReachRuleWriteV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';
import { createReachRulesController, type ReachRulesSource } from '@/sync/domains/capabilities/reach/useReachRulesState';
import { createCapabilityEnableApprovalController, readCapabilityEnableApproval, resolveCapabilityAlwaysWrite } from './capabilityEnableApproval';

type CapabilityEnableApprovalController = ReturnType<typeof createCapabilityEnableApprovalController>;
type SharedLatest = Readonly<{ alwaysWrite: ReachRuleWriteV1 | null; key: string;
    decide(decision: 'approve' | 'reject'): Promise<boolean> }>;
type SharedController = Readonly<{ controller: CapabilityEnableApprovalController; writers: { latest: SharedLatest };
    rules: ReturnType<typeof createReachRulesController> }>;
/**
 * One decision per approval: the attention tray and the transcript row both draw this request, and the tray's
 * copy leaves as soon as the approval settles. Both share the controller, so the settled line, a pending
 * Always write and its failure stay visible where the request remains. An undecided entry leaves once nothing
 * shows it; a decided one stays for this app run (one small entry per request decided on this device).
 */
const sharedControllers = new Map<string, SharedController>();
function createShared(key: string, latest: SharedLatest, source: ReachRulesSource, scope: ServerAccountScope | null): SharedController {
    const writers = { latest };
    const rules = createReachRulesController(source, createRequestOwnedActionExecution(scope));
    const controller = createCapabilityEnableApprovalController({
        get alwaysWrite() { return writers.latest.key === key ? writers.latest.alwaysWrite : null; },
        decide: decision => writers.latest.decide(decision),
        changeRules: rules.change,
        undoRules: rules.undoLast,
    });
    const entry = { controller, writers, rules };
    sharedControllers.set(key, entry);
    return entry;
}
function retainSharedController(key: string, controller: CapabilityEnableApprovalController, listener: () => void) {
    const unsubscribe = controller.subscribe(listener);
    return () => {
        unsubscribe();
        let watcher: (() => void) | null = null;
        const release = () => {
            const status = controller.getSnapshot().status;
            if (status === 'deciding' || status === 'saving_always') return;
            watcher?.();
            // A decision made here keeps its outcome for this app run: the tray copy leaves on settle, and
            // Details or the transcript must still show "Couldn't save Always · Try again" or the Undo.
            if (status !== 'idle') return;
            if (controller.listenerCount() === 0 && sharedControllers.get(key)?.controller === controller) sharedControllers.delete(key);
        };
        if (controller.listenerCount() > 0) return;
        watcher = controller.subscribe(release);
        release();
    };
}

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
    const kind = request?.kind === 'skill' ? 'skill' : 'mcp_server';
    const reach = useReachRulesCatalog(kind, request?.id ?? '', scope);
    const alwaysWrite = request && reach.status === 'ready' ? resolveCapabilityAlwaysWrite({ decidedBy: input.decidedBy, rules: reach.rules,
        projectKey: input.projectKey, machineId: input.machineId }) : null;
    // One decision per request and Account: every view of it (tray, transcript, Details) shares this controller.
    // View data may refresh; the request's acknowledged write and Undo remain owned by this entry.
    const key = JSON.stringify([input.artifact.id, scope?.serverId, scope?.accountId]);
    const source: ReachRulesSource = { key, kind, itemId: request?.id ?? '', rules: reach.acknowledgedRules,
        revision: reach.revision, status: reach.status, valueAvailable: reach.valueAvailable };
    const current: SharedLatest = { alwaysWrite, key, decide };
    const shared = React.useMemo(() => request ? sharedControllers.get(key) ?? createShared(key, current, source, scope) : null, [key]);
    if (shared) shared.writers.latest = current;
    React.useLayoutEffect(() => { shared?.rules.updateSource(source); });
    const controller = shared?.controller ?? null;
    const subscribe = React.useCallback((listener: () => void) => controller ? retainSharedController(key, controller, listener) : () => {}, [controller, key]);
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
