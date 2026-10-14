import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { DaemonLocalServiceLauncherStartResponseV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { createProjectServiceDeclarationTargetIdV1 } from '@happier-dev/protocol/local/services/actions/v1';
import { ProjectWorkerStatusResultV1Schema } from '@happier-dev/protocol/actions/specs/projectWorkers';
import { ProjectServicePlacementMutationResultV1Schema } from '@happier-dev/protocol/workspaces/projectServicePlacementV1';
import type { ProjectServiceRelocateInputV1 } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import type { RuntimeActionExecuteArgs } from '@happier-dev/protocol/actions';

import type { StoredCredentials } from '@/persistence';
import type { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import type { WorkspaceSyncHandoffAdapter } from '@/workspaces/sync/workspaceSyncHandoffAdapter';
import {
    readWorkspaceSyncWorkerTargetSnapshot,
    resolveWorkspaceSyncWorkerTarget,
} from '@/workspaces/sync/workspaceSyncPreparation';
import { createProjectServiceRelocation } from '@/workspaces/execution/projectServiceRelocation';

type CanonicalChildAction = NonNullable<RuntimeActionExecuteArgs['executeCanonicalAction']>;

function refusal(reasonCode: string) {
    return { status: 'refused' as const, reasonCode };
}

/** Production composition for the source-daemon relocation coordinator. */
export function createProjectServiceRelocationRoute(input: Readonly<{
    serverBaseUrl: string;
    credentials: StoredCredentials;
    projectManagedServices: Pick<ReturnType<typeof createManagedServicesOwner>, 'resolveProjectService'>;
    resolveWorkspaceSyncHandoffAdapter(): WorkspaceSyncHandoffAdapter | null;
}>) {
    return async (
        request: ProjectServiceRelocateInputV1,
        context: RuntimeActionExecuteArgs['context'],
        executeCanonicalAction?: RuntimeActionExecuteArgs['executeCanonicalAction'],
    ) => {
        const execute = executeCanonicalAction as CanonicalChildAction | undefined;
        const resolveDestination = async (signal?: AbortSignal) => {
            const targetMachineId = request.selectedTarget.machineId;
            try {
                const snapshot = await readWorkspaceSyncWorkerTargetSnapshot({
                    serverId: request.workspace.serverId,
                    serverHttpBaseUrl: input.serverBaseUrl,
                    targetMachineId,
                    sourceWorkspaceRefId: request.workspace.refId,
                    credentials: input.credentials,
                    ...(signal ? { signal } : {}),
                });
                const basis = resolveWorkspaceSyncWorkerTarget({
                    serverId: request.workspace.serverId,
                    sourceWorkspaceRefId: request.workspace.refId,
                    targetMachineId,
                    workspaceRefs: snapshot.workspaceRefs,
                    relationships: snapshot.relationships,
                    childMachines: snapshot.childMachines,
                });
                return basis.ok ? { status: 'resolved' as const, workspace: basis.target }
                    : refusal(basis.errorCode);
            } catch (error) {
                signal?.throwIfAborted();
                return refusal(error instanceof Error && 'code' in error && typeof error.code === 'string'
                    ? error.code : 'workspace_sync_source_unavailable');
            }
        };
        const coordinator = createProjectServiceRelocation({
            readService: async () => {
                const resolved = input.projectManagedServices.resolveProjectService(request.currentTarget);
                if (resolved.status !== 'found') {
                    return refusal(resolved.status === 'mismatch' ? 'service_inputs_changed' : 'unknown_managed_service');
                }
                const handle = resolved.handle;
                if (!handle.execution) return refusal('service_execution_unavailable');
                return {
                    status: 'resolved' as const,
                    execution: handle.execution,
                    currentTarget: {
                        ...request.currentTarget,
                        machineId: handle.workspace.machineId,
                        workspaceId: handle.workspace.id,
                        cwd: handle.cwd,
                        declaration: handle.declaration,
                    },
                    workspace: handle.workspace,
                    instanceId: handle.instanceId,
                    snapshot: handle.snapshot(),
                };
            },
            resolveDestination: async (_request, signal) => await resolveDestination(signal),
            saveDesiredPlacement: async (placement, signal) => {
                if (!execute) return { status: 'unavailable' as const };
                const result = await execute('projects.service.placement.set', placement);
                signal?.throwIfAborted();
                if (!result.ok) return { status: 'unavailable' as const };
                const parsed = ProjectServicePlacementMutationResultV1Schema.safeParse(result.result);
                return parsed.success ? parsed.data : { status: 'unavailable' as const };
            },
            stopService: async (target, signal) => {
                const resolved = input.projectManagedServices.resolveProjectService(target);
                if (resolved.status !== 'found') return { status: 'termination_incomplete' as const };
                const stopped = await resolved.handle.stop(signal ? { signal } : undefined);
                return { status: stopped.status === 'stopped' ? 'stopped' as const : 'termination_incomplete' as const };
            },
            revalidateDestination: async (_request, destination, signal) => {
                const current = await resolveDestination(signal);
                if (current.status === 'refused') return current;
                if (createCanonicalJsonSigningInput(current.workspace) !== createCanonicalJsonSigningInput(destination)) {
                    return refusal('selected_target_changed');
                }
                if (!execute) return refusal('project_worker_status_unavailable');
                const result = await execute('projects.worker.status', {
                    workspace: request.workspace,
                    destination: { kind: 'machine', machineId: destination.machineId },
                    purpose: 'service-start',
                });
                signal?.throwIfAborted();
                if (!result.ok) return refusal(result.errorCode ?? 'project_worker_status_unavailable');
                const status = ProjectWorkerStatusResultV1Schema.safeParse(result.result);
                return status.success && status.data.eligible
                    && status.data.candidate.machineId === destination.machineId
                    ? { status: 'admitted' as const }
                    : refusal(status.success && !status.data.eligible
                        ? `project_worker_${status.data.explanation}` : 'project_worker_status_unavailable');
            },
            handoffPrepareBetween: async (preparation, signal) => {
                const adapter = input.resolveWorkspaceSyncHandoffAdapter();
                if (!adapter) return { ok: false as const, errorCode: 'workspace_sync_unavailable', completed: [] };
                return await adapter.prepareBetween(preparation, signal);
            },
            startService: async (_request, destination, signal) => {
                if (!execute) return { status: 'failed' as const, reasonCode: 'launcher_start_unavailable' };
                const declaration = {
                    workspaceRefId: destination.id,
                    selection: request.currentTarget.declaration.selection,
                };
                const result = await execute('localServices.launcher.start', {
                    machineId: destination.machineId,
                    targetId: createProjectServiceDeclarationTargetIdV1(destination, declaration.selection),
                    workspaceId: destination.id,
                    workspace: {
                        serverId: destination.serverId,
                        machineId: destination.machineId,
                        workspaceId: destination.id,
                        rootPath: destination.rootPath,
                    },
                    declaration,
                    // The pool has already settled to this reviewed exact Machine.
                    choice: request.destination.kind === 'primary'
                        ? { kind: 'primary' }
                        : { kind: 'workers', destination: { kind: 'machine', machineId: destination.machineId } },
                });
                signal?.throwIfAborted();
                if (!result.ok) return { status: 'failed' as const, reasonCode: result.errorCode ?? 'launcher_start_failed' };
                const parsed = DaemonLocalServiceLauncherStartResponseV1Schema.safeParse(result.result);
                return parsed.success ? {
                    status: parsed.data.status,
                    ...(parsed.data.reasonCode ? { reasonCode: parsed.data.reasonCode } : {}),
                    ...(parsed.data.currentTarget ? { currentTarget: parsed.data.currentTarget } : {}),
                } : { status: 'failed' as const, reasonCode: 'launcher_start_result_unavailable' };
            },
        });
        return await coordinator(request, {
            signal: context.signal,
            updateProgress: context.operationProgress?.update,
            publishOwnerUpdate: context.operationOwnerUpdate?.update,
        });
    };
}
