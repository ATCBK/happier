import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { resolveMachineSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import type { MachineReachabilityScope } from '@/sync/domains/machines/reachability/machineReachability';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import type {
    ServerScopedMachine,
    ServerScopedMachineGroup,
    ServerScopedMachinePresentation,
} from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import { Text } from '@/components/ui/text/Text';
import { Icon } from '@/components/ui/icons/Icon';
import { getMachineDisplayName, resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';


type ServerScopedMachineSelectorProps<TMachine extends ServerScopedMachinePresentation> = Readonly<{
    groups: ReadonlyArray<ServerScopedMachineGroup<TMachine>>;
    selectedMachineId: string | null;
    selectedServerId: string | null;
    onSelect: (machine: TMachine) => void;
    /**
     * Lets a consuming domain project its own already-decided availability
     * facts while retaining this component as the one grouped-machine picker.
     */
    resolveMachineAvailability?: (machine: TMachine) => Readonly<{
        detail: string;
        selectable: boolean;
    }>;
    /** Lets the owning domain suppress opaque ids and add safe disambiguation. */
    resolveMachinePresentation?: (machine: TMachine) => Readonly<{
        title: string;
        subtitle?: string;
    }>;
    /** Exact row identity for domains whose choice is finer than machine id. */
    getMachineKey?: (machine: TMachine) => string;
    /** Exact selection predicate for domains whose choice is finer than machine id. */
    isMachineSelected?: (machine: TMachine) => boolean;
    testIdPrefix?: string;
}>;

const emptyTextStyle = {
    ...Typography.variant('body'),
    opacity: 0.8,
    paddingHorizontal: 16,
    paddingVertical: 8,
};

function resolveGroupedMachineAvailability(machine: ServerScopedMachinePresentation, scope: MachineReachabilityScope | null | undefined): Readonly<{
    detail: string;
    selectable: boolean;
}> {
    const readiness = resolveMachineSpawnReadiness({
        machine,
        selectedMachineId: machine.id,
        scope,
    });

    if (readiness.status === 'ready') {
        return { detail: t('status.online'), selectable: true };
    }

    if (readiness.status === 'revoked' || readiness.status === 'replaced') {
        return {
            detail: t('common.unavailable'),
            selectable: false,
        };
    }

    return {
        detail: t('status.offline'),
        selectable: false,
    };
}

export function ServerScopedMachineSelector<
    TMachine extends ServerScopedMachinePresentation = ServerScopedMachine,
>(props: ServerScopedMachineSelectorProps<TMachine>) {
    const { theme } = useUnistyles();
    useMachineReachabilityRevision();
    const bindings = useServerCredentialAccountScopeBindings(props.groups.map(group => group.serverId));
    const optionTestIdPrefix = props.testIdPrefix ? `${props.testIdPrefix}-option` : undefined;
    const readinessTestIdPrefix = props.testIdPrefix ? `${props.testIdPrefix}-readiness` : undefined;

    return (
        <>
            {props.groups.map((group) => {
                const title = `${group.serverName} (${group.machines.length})`;
                const machineNames = resolveMachineDisplayNames(group.machines);
                return (
                    <ItemGroup key={group.serverId} title={title}>
                        {group.loading ? (
                            <View>
                                <Text style={[emptyTextStyle, { color: theme.colors.text.secondary }]}>
                                    {t('common.loading')}
                                </Text>
                            </View>
                        ) : null}
                        {!group.loading && group.signedOut ? (
                            <View>
                                <Text style={[emptyTextStyle, { color: theme.colors.text.secondary }]}>
                                    {t('server.signedOut')}
                                </Text>
                            </View>
                        ) : null}
                        {!group.loading && !group.signedOut && group.machines.length === 0 ? (
                            <View>
                                <Text style={[emptyTextStyle, { color: theme.colors.text.secondary }]}>
                                    {t('newSession.noMachinesFound')}
                                </Text>
                            </View>
                        ) : null}
                        {!group.loading && !group.signedOut
                            ? group.machines.map((machine) => {
                                const machineKey = props.getMachineKey?.(machine) ?? machine.id;
                                const isSelected = props.isMachineSelected?.(machine)
                                    ?? (props.selectedMachineId === machine.id
                                        && props.selectedServerId === group.serverId);
                                const availability = props.resolveMachineAvailability?.(machine)
                                    ?? resolveGroupedMachineAvailability(machine, bindings.get(resolveServerProfileScopeIdForIdentifier(group.serverId))?.isCurrent() ? bindings.get(resolveServerProfileScopeIdForIdentifier(group.serverId))?.scope : null);
                                const presentation = props.resolveMachinePresentation?.(machine);
                                return (
                                    <Item
                                        key={`${group.serverId}::${machineKey}`}
                                        testID={optionTestIdPrefix ? `${optionTestIdPrefix}:${machineKey}` : undefined}
                                        title={presentation?.title ?? machineNames.get(machine.id) ?? getMachineDisplayName(machine)}
                                        titleEllipsizeMode="middle"
                                        subtitle={presentation?.subtitle ?? machine.metadata?.host ?? undefined}
                                        icon={<Icon name="desktop" size={20} color={theme.colors.text.secondary} />}
                                        selected={isSelected}
                                        detail={availability.detail}
                                        detailTestID={readinessTestIdPrefix ? `${readinessTestIdPrefix}:${machine.id}` : undefined}
                                        disabled={!availability.selectable}
                                        onPress={() => {
                                            if (!availability.selectable) return;
                                            props.onSelect(machine);
                                        }}
                                    />
                                );
                            })
                            : null}
                    </ItemGroup>
                );
            })}
        </>
    );
}
