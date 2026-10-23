import * as React from 'react';
import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { MachineProvisionersListResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/contributions/public-types';
import type { PluginProjectedActionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { createPluginUiProjectedActionResolver, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { machinePluginActionSchemasRead } from '@/sync/ops/machineContributionRegistryProjection';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';

export type ManagedProvisionerOptionsInput = Readonly<{ kind: 'none' | 'loading' }>
    | Readonly<{ kind: 'unavailable'; error: string }>
    | Readonly<{ kind: 'ready'; schema: PluginJsonSchemaV2; action: PluginProjectedActionV2 }>;
const none = { kind: 'none' } as const;
const loading = { kind: 'loading' } as const;
const controllerUnavailable = { kind: 'unavailable', error: 'controller_unavailable' } as const;
const actionUnavailable = { kind: 'unavailable', error: 'action_not_found' } as const;
const projectionUnavailable = { kind: 'unavailable', error: 'projection_unavailable' } as const;
const timedOutUnavailable = { kind: 'unavailable', error: 'timeout' } as const;

/**
 * Describes the actual options role, pinned to its projected occurrence and captured Home.
 * The projection read and the schema read carry no operation deadline of their own (they follow their
 * caller), so this caller bounds the whole question by the RPC budget its sibling check/options reads
 * already run under; a failed projection settles at once. Either way the page shows its error and Retry
 * (`refreshKey`) instead of "checking" indefinitely.
 */
export function useManagedProvisionerOptionsInput(input: Readonly<{
    binding: ServerCredentialAccountScopeBinding | null;
    controller?: ManagedControllerV1;
    provisioner?: MachineProvisionersListResultV1['provisioners'][number];
    projection: PluginUiProjectionModel;
    projectionReady: boolean;
    /** The controller's projection read ended without an answer (error or unsupported). */
    projectionFailed?: boolean;
    /** Changes when the person asks to read again. */
    refreshKey?: number;
}>): ManagedProvisionerOptionsInput {
    const { binding, controller, provisioner, projection, projectionReady, projectionFailed, refreshKey } = input;
    const localId = provisioner?.descriptor.actions.options;
    const identity = localId && provisioner ? { pluginId: provisioner.contribution.pluginId, localId } : null;
    // A projection refresh retains the last current declaration while it revalidates. Keep the exact
    // occurrence's schema read alive through that loading phase; the daemon still enforces occurrence
    // currentness, and a changed occurrence below starts a replacement read.
    const action = identity ? createPluginUiProjectedActionResolver(projection.actionsById)(identity) : null;
    const questionKey = JSON.stringify([binding?.scope, binding?.revision, controller, identity, refreshKey]);
    const key = JSON.stringify([questionKey, action?.occurrenceId]);
    const asking = !!identity && !!controller && !!binding?.isCurrent();
    const [timedOut, setTimedOut] = React.useState<string | null>(null);
    React.useEffect(() => {
        if (!asking) return;
        const timer = setTimeout(() => setTimedOut(questionKey), DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS);
        return () => clearTimeout(timer);
    }, [asking, questionKey]);
    const [state, setState] = React.useState<Readonly<{ key: string; value: ManagedProvisionerOptionsInput }>>({ key: '', value: { kind: 'loading' } });
    React.useEffect(() => {
        if (!binding?.isCurrent() || !controller || !identity || !action) return;
        const abort = new AbortController();
        const retirement = binding.onRetire(() => { abort.abort(); setState({ key: '', value: { kind: 'loading' } }); });
        setState({ key, value: { kind: 'loading' } });
        void machinePluginActionSchemasRead(controller.machineId, {
            serverId: binding.serverId, expectedOccurrenceId: action.occurrenceId,
            qualifiedActionId: buildQualifiedPluginContributionKey(identity), signal: abort.signal,
        }).then(result => {
            if (abort.signal.aborted || !binding.isCurrent()) return;
            const value: ManagedProvisionerOptionsInput = !result.supported ? { kind: 'unavailable', error: result.reason }
                : !result.result.ok ? { kind: 'unavailable', error: result.result.code }
                    : !result.result.inputSchema ? { kind: 'unavailable', error: 'option_unavailable' }
                    : { kind: 'ready', action, schema: result.result.inputSchema };
            setState({ key, value });
        }).catch(() => {
            if (!abort.signal.aborted && binding.isCurrent()) setState({ key, value: { kind: 'unavailable', error: 'unavailable' } });
        });
        return () => { abort.abort(); retirement.dispose(); };
    // A reloading projection hands out a new Action object for the same occurrence; only the occurrence restarts the read.
    }, [binding, controller?.machineId, controller?.installationId, action?.occurrenceId, key]);
    if (!localId) return none;
    if (!binding?.isCurrent() || !controller) return controllerUnavailable;
    if (state.key === key && state.value.kind !== 'loading') return state.value;
    if (projectionFailed) return projectionUnavailable;
    if (timedOut === questionKey) return timedOutUnavailable;
    if (!projectionReady) return loading;
    if (!action) return actionUnavailable;
    return state.key === key ? state.value : loading;
}
