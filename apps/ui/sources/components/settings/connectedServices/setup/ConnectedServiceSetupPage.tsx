import * as React from 'react';
import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';

import { ItemList } from '@/components/ui/lists/ItemList';
import { Item } from '@/components/ui/lists/Item';
import { useConnectedServicesIndex } from '../model/useConnectedServicesIndex';
import { buildConnectedServiceSetupCatalog } from './buildConnectedServiceSetupCatalog';
import { ConnectedServiceSetupPanel, type ConnectedServiceSetupTarget } from './ConnectedServiceSetupPanel';
import { ConnectedAccountPurposeTargetChooser } from '../account/ConnectedAccountPurposeTargetChooser';
import { useScopedPluginUiProjection } from '@/components/plugins/projection/useScopedPluginUiProjection';
import { useActiveServerAccountScope, useProfile } from '@/sync/store/hooks';
import { useConnectedAccountPurposeDefaults } from '@/hooks/server/connectedServices/useConnectedAccountPurposeDefaults';
import { ConnectedAccountCatalogOperationError } from '@/sync/api/account/apiConnectedAccountCatalog';
import { getStorage } from '@/sync/domains/state/storageStore';
import { captureActiveServerAccountScopeLifetime, getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { readConnectedAccountPurposeSetupRequest, readConnectedAccountPurposeSetupDeclaration,
    resolveConnectedAccountPurposeSetupSelectedAccount, type ConnectedAccountPurposeSetupRequest } from '@/sync/domains/connectedServices/connectedAccountPurposeSetup';
import { qualifiedPurposeKey, type QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Modal } from '@/modal';
import { t } from '@/text';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { ConnectedAccountActionApprovalNotice } from '../ConnectedAccountActionApprovalNotice';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { useMachineAdministrationTargetSelection, type MachineAdministrationTargetSelectionV1 } from '@/sync/domains/machines/administration/useTargetSelection';
import { readMachineAdministrationTargetRouteParams } from '@/sync/domains/machines/administration/targetSelection';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { projectConnectedServiceRegistryEntries, type ConnectedServiceRegistrySnapshot } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { useConnectedAccountIdentityPrivacy } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

/** Phone push presentation of the same catalog and authentication owner as the inline block. */
export function ConnectedServiceSetupPage(props: Readonly<{
    /** An inline consumer owns the returned choice, not a persisted Resource default. */
    purposeRequest?: ConnectedAccountPurposeSetupRequest;
    selectedTarget?: QualifiedConnectedAccountPurposeBindingTargetV1 | null;
    initialTarget?: ConnectedServiceSetupTarget;
    targetSelection?: MachineAdministrationTargetSelectionV1;
    onSelected?: (account: QualifiedConnectedAccountRef) => void | Promise<void>;
    onClose?: () => void;
}> = {}) {
    const router = useRouter();
    const params = useLocalSearchParams<{ service?: string; accountId?: string; purpose?: string;
        machineId?: string; serverIdentityId?: string; expectedAccountId?: string;
        purposeConsumerPlugin?: string; purposeConsumerId?: string; purposeServerId?: string; purposeAccountId?: string; purposeMachineId?: string }>();
    const request = React.useMemo(() => props.purposeRequest ?? readConnectedAccountPurposeSetupRequest(params), [props.purposeRequest, params.purpose,
        params.purposeConsumerPlugin, params.purposeConsumerId, params.purposeServerId, params.purposeAccountId, params.purposeMachineId]);
    const viewer = useActiveServerAccountScope();
    const explicitTarget = params.machineId !== undefined || params.serverIdentityId !== undefined;
    const routeTarget = React.useMemo(() => readMachineAdministrationTargetRouteParams(params), [params.machineId, params.serverIdentityId]);
    const routeTargetSelection = useMachineAdministrationTargetSelection(MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.connectedAccounts, {
        enabled: props.targetSelection === undefined && (params.expectedAccountId === undefined || params.expectedAccountId === viewer?.accountId),
        ...(explicitTarget ? { initialTarget: routeTarget } : {}),
    });
    const profile = useProfile();
    const { present } = useConnectedAccountIdentityPrivacy();
    const { catalog: purposeCatalog, mutateDefaults, execution } = useConnectedAccountPurposeDefaults();
    const lifetime = React.useMemo(() => captureActiveServerAccountScopeLifetime(), [viewer]);
    const purposeRuntime = useScopedPluginUiProjection({ machineId: request?.machineId, serverId: request?.scope.serverId, enabled: Boolean(request) });
    const latestRuntime = React.useRef(purposeRuntime);
    latestRuntime.current = purposeRuntime;
    const declaration = readConnectedAccountPurposeSetupDeclaration(request, viewer, purposeRuntime);
    const registry = React.useMemo<ConnectedServiceRegistrySnapshot | undefined>(() => {
        if (!request) return undefined;
        const descriptors = purposeRuntime.connectedAccountProjection;
        const state = { scopeKey: JSON.stringify([request.scope, request.machineId]),
            status: purposeRuntime.phase === 'current' && descriptors?.kind === 'ready' ? 'ready' as const : 'loading' as const,
            descriptors: descriptors?.kind === 'ready' ? descriptors.descriptors : [], conflicts: [], errorReason: null };
        return { ...state, entries: projectConnectedServiceRegistryEntries(state) };
    }, [request, purposeRuntime.phase, purposeRuntime.connectedAccountProjection]);
    const { indexModel } = useConnectedServicesIndex({ agents: request ? 'cached' : 'load', registry });
    const catalog = React.useMemo(() => buildConnectedServiceSetupCatalog(indexModel).filter(entry => !request ||
        declaration?.serviceRefs.some(service => service.pluginId === entry.service.pluginId && service.localId === entry.service.localId)), [indexModel, request, declaration]);
    const [target, setTarget] = React.useState<ConnectedServiceSetupTarget>(() => props.initialTarget ?? (typeof params.service !== 'string' ? { kind: 'catalog' }
        : typeof params.accountId === 'string' && params.accountId ? { kind: 'reconnect', serviceKey: params.service, accountId: params.accountId }
            : { kind: 'service', serviceKey: params.service }));
    const close = () => { if (props.onClose) props.onClose(); else router.back(); };
    const select = async (next: QualifiedConnectedAccountPurposeBindingTargetV1 | null) => {
        if (!request) return;
        try {
            const selected = resolveConnectedAccountPurposeSetupSelectedAccount({ request,
                viewer: getActiveServerAccountScope(), runtime: latestRuntime.current,
                profile: getStorage().getState().profile, target: next });
            if (lifetime?.isCurrent() !== true || !selected) throw new ConnectedAccountCatalogOperationError('scope-retired');
            if (!next) throw new ConnectedAccountCatalogOperationError('connected_account_purpose_unavailable');
            if (props.onSelected) await props.onSelected(selected.ref);
            else {
                if (!declaration || declaration.consumerKind === 'machineProvisioner') throw new ConnectedAccountCatalogOperationError('connected_account_purpose_unavailable');
                await mutateDefaults({ kind: 'resource', input: { machineId: request.machineId, purpose: request.purpose, target: next } });
                if (lifetime?.isCurrent()) close();
            }
        } catch {
            Modal.alert(t('common.error'), t('widgetAdd.inputsUnavailable'));
        }
    };
    if (params.expectedAccountId !== undefined && params.expectedAccountId !== viewer?.accountId
        || (props.purposeRequest || params.purpose !== undefined) && (!request || !declaration || profile.id !== request.scope.accountId
        || declaration.consumerKind === 'machineProvisioner' && !props.onSelected)) return <ItemList>
        {props.onClose ? <Item testID="connected-service-setup:close" title={t('common.cancel')} onPress={close} /> : null}
        <SurfaceStateCard testID="connected-account-purpose-unavailable" kind={purposeRuntime.phase === 'establishing' ? 'loading' : 'unavailable'}
            title={t('settings.connectedServices')} diagnosticCode="connected_account_purpose_unavailable" accessibilitySemantics="status" />
    </ItemList>;
    const selected = props.onSelected ? props.selectedTarget ?? null
        : request ? purposeCatalog.value?.bindings.find(binding => qualifiedPurposeKey(binding.purpose) === qualifiedPurposeKey(request.purpose))?.target ?? null : null;
    return <ItemList>
        <ConnectedAccountActionApprovalNotice execution={execution} testID="connected-service-setup-approval-pending" />
        {props.onSelected && declaration && profile.connectedAccountsV4.filter(account => account.status === 'needs_reauth'
            || account.status === 'refresh_failed_retryable').filter(account => declaration.serviceRefs.some(service =>
                service.pluginId === account.ref.service.pluginId && service.localId === account.ref.service.localId)).map(account => {
            const identity = present({ label: account.displayName, email: account.providerIdentity?.email, accountId: account.ref.accountId });
            return <Item key={JSON.stringify(account.ref)} testID={`connected-account-purpose-reconnect:${buildQualifiedPluginContributionKey(account.ref.service)}:${account.ref.accountId}`}
                title={t('connectedServices.detail.actions.reconnect')}
                subtitle={identity.label ?? identity.email ?? identity.accountId ?? undefined}
                onPress={() => setTarget({ kind: 'reconnect', serviceKey: buildQualifiedPluginContributionKey(account.ref.service), accountId: account.ref.accountId })} />;
        })}
        {request && declaration?.serviceRefs.map(service => <ConnectedAccountPurposeTargetChooser
            key={`${service.pluginId}/${service.localId}`} testID={`connected-account-purpose:${service.pluginId}/${service.localId}`}
            registry={registry}
            localizedTextPluginId={request.purpose.consumer.pluginId} declaration={{ purpose: request.purpose.purpose, service, required: true }}
            value={selected} disabled={!props.onSelected && (purposeCatalog.status !== 'ready' || purposeCatalog.stale)}
            disabledReason={props.onSelected || purposeCatalog.status === 'ready' && !purposeCatalog.stale ? undefined
                : t(purposeCatalog.status === 'loading' ? 'common.loading' : 'common.unavailable')}
            onChange={next => { void select(next); }} />)}
        <ConnectedServiceSetupPanel chrome="page" target={target} catalog={catalog} registry={registry} targetSelection={props.targetSelection ?? routeTargetSelection}
        targetLocked={Boolean(props.purposeRequest)}
        onTargetChange={setTarget} onClose={close}
        onConnected={(account, serviceKey) => {
            if (request) {
                // Authentication settling is distinct from selecting the Resource purpose.
                // Refresh the canonical Account inventory before admitting the returned ref.
                void (async () => {
                    try {
                        if (!lifetime?.isCurrent()) return;
                        await getSyncSingleton().refreshProfile();
                        if (lifetime.isCurrent()) await select({ kind: 'account', account });
                    } catch { Modal.alert(t('common.error'), t('widgetAdd.inputsUnavailable')); }
                })();
                return;
            }
            router.dismissTo({ pathname: '/(app)/settings/connected-services',
                params: { connectedService: serviceKey, connectedAccount: account.accountId } });
        }} />
    </ItemList>;
}
