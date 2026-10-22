import type { ProjectDefinitionWorkspace } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { readRequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";
import { projectRuntimeAccountRowsInput } from '@/workspaces/projectAccountRows';
import { readProjectRuntimeRequesterRefusal, type ProjectFiniteActionRuntime } from './projectFiniteAction';
import { resolveProjectSetupAcceptedWorkspace } from './projectSetupAcceptedWorkspace';
import { inspectProjectSetup, type ProjectSetupInspection } from './projectSetupPreparation';
import { resolveProjectRequesterSecretEnvironment } from './projectSetupRequesterInputs';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { logger } from '@/ui/logger';

/** Passive review uses the same captured requester, current target, and native owner as execution. */
export async function inspectProjectSetupFromRuntime(input: Readonly<{
    runtime: ProjectFiniteActionRuntime; ingress: RpcHandlerContext; workspace: ProjectDefinitionWorkspace; context: ActionExecutorContext;
    reviewSetupConsent?: true;
}>): Promise<ProjectSetupInspection> {
    const { runtime: authorityRuntime, ingress } = input;
    const runtime = { ...authorityRuntime, serverId: input.workspace.serverId };
    const signal = input.context.signal ? AbortSignal.any([ingress.signal, input.context.signal]) : ingress.signal;
    const phase = async <T>(name: string, read: () => T | Promise<T>): Promise<T> => {
        const startedAt = performance.now();
        let status: 'completed' | 'failed' = 'failed';
        try { const result = await read(); status = 'completed'; return result; }
        finally { logger.debug('[ProjectSetup] inspection phase', { phase: name, status,
            requestId: input.context.actionRequestId ?? ingress.transportRequestId,
            durationMs: Math.round(performance.now() - startedAt) }); }
    };
    let releaseRequester: (() => Promise<void>) | undefined;
    const unknown = (code: string): ProjectSetupInspection => ({ setupReadiness: { kind: 'unknown', code } });
    const current = async () => !signal.aborted && (!runtime.isCurrent || await phase('requester_currentness', () => runtime.isCurrent!()))
        && Boolean(ingress.verifyMachineAdmissionCurrent && await phase('machine_admission', () => ingress.verifyMachineAdmissionCurrent!()));
    try {
        if (!await isServerProfileHomeIdentity(authorityRuntime.serverId, input.workspace.serverId) || input.workspace.machineId !== runtime.machineId
            || ingress.machineAdmission && ingress.machineAdmission.machineId !== runtime.machineId) return unknown('target_mismatch');
        const refused = await phase('requester', () => readProjectRuntimeRequesterRefusal(authorityRuntime, ingress));
        if (refused) return unknown(refused.errorCode);
        // Admitted requester resolution already brackets fresh Machine admission
        // with installed, Account and HTTP custody. Consume that initial fence
        // directly; no async work intervenes before the first private read.
        // Legacy own-Account resolution only checks identity, so still admit it.
        if (signal.aborted || !ingress.callerInputAuthorization && !await current()) return unknown('project_requester_credentials_unavailable');
        releaseRequester = readRequesterAccountActionContext(runtime.accountAuthorization)?.retain();
        const association = await phase('workspace', () => resolveProjectSetupAcceptedWorkspace({ address: input.workspace,
            ...projectRuntimeAccountRowsInput(runtime), serverId: runtime.serverId,
            serverHttpBaseUrl: runtime.serverHttpBaseUrl, signal }));
        const secretEnvironment = await phase('requester_environment', () => resolveProjectRequesterSecretEnvironment(runtime, undefined, signal));
        if (!await current()) return unknown('project_requester_credentials_unavailable');
        const inspection = await phase('review', () => inspectProjectSetup({ workspace: association.workspace, projectAssociation: association,
            requester: { ...projectRuntimeAccountRowsInput(runtime), serverHttpBaseUrl: runtime.serverHttpBaseUrl },
            purpose: 'setup', approvalContext: input.context,
            platform: { os: (runtime.platform ?? process.platform) === 'win32' ? 'windows' : runtime.platform ?? process.platform,
                arch: runtime.arch ?? process.arch }, nativeIo: runtime.nativeIo, signal,
            ...(secretEnvironment ? { secretEnvironment } : {}), ...(runtime.configEnvironment ? { configEnvironment: runtime.configEnvironment } : {}),
            ...(runtime.plugins ? { plugins: runtime.plugins } : {}), ...(runtime.successHomeDir ? { successHomeDir: runtime.successHomeDir } : {}) },
            input.reviewSetupConsent ? { reviewConsent: true } : undefined));
        return await current() ? inspection : unknown('project_requester_credentials_unavailable');
    } catch (error) {
        return unknown(error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'project_setup_requester_review_unavailable');
    } finally {
        await releaseRequester?.();
    }
}
