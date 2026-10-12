import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import type { ReachPlaceV1 } from '@happier-dev/protocol';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import { getMachineDisplayName, resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { describeMachinePresenceLine } from '@/utils/sessions/machinePresenceLine';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';

type BindingTargetType = ReachPlaceV1['t'];
type MachineScopedBindingTargetType = Extract<BindingTargetType, 'machine' | 'workspace'>;

export function describeBindingTarget(target: ReachPlaceV1, machines: readonly Machine[]): string {
    if (target.t === 'allMachines') return t('settings.mcpServersBindingTargetAllMachines');
    if (target.t === 'project') return target.projectKey;
    const machine = machines.find((m) => m.id === target.machineId) ?? null;
    // A machine missing from the inventory has no name to show, so its id is the only truthful label.
    const machineLabel = getMachineDisplayName(machine) ?? target.machineId;
    if (target.t === 'machine') return t('settings.mcpServersBindingTargetMachine', { machine: machineLabel });
    return t('settings.mcpServersBindingTargetWorkspace', { machine: machineLabel, path: target.workspaceRoot });
}

export const McpBindingTargetFields = React.memo(function McpBindingTargetFields(props: Readonly<{
    target: ReachPlaceV1;
    machines: readonly Machine[];
    onChangeTargetType: (nextType: BindingTargetType, selectedMachineId?: string) => void;
    onChangeMachineId: (machineId: string) => void;
    onOpenWorkspacePicker: () => void;
}>) {
    const { theme } = useUnistyles();
    const scope = useActiveServerAccountScope();
    const presenceNowMs = useMachinePresenceNowMs(props.machines);
    const reachabilityRevision = useMachineReachabilityRevision();
    const [openMenu, setOpenMenu] = React.useState<null | 'targetType' | 'machine'>(null);
    const [pendingMachineScopedTargetType, setPendingMachineScopedTargetType] = React.useState<MachineScopedBindingTargetType | null>(null);

    const targetTypeItems = React.useMemo((): DropdownMenuItem[] => {
        return [
            {
                id: 'allMachines',
                title: t('settings.mcpServersBindingTargetAllMachines'),
                subtitle: t('settings.mcpServersBindingTargetAllMachinesSubtitle'),
                icon: <Icon name="globe" size={20} color={theme.colors.text.secondary} />,
            },
            {
                id: 'machine',
                title: t('settings.mcpServersBindingTargetMachineTitle'),
                subtitle: t('settings.mcpServersBindingTargetMachineSubtitle'),
                icon: <Icon name="laptop" size={20} color={theme.colors.text.secondary} />,
            },
            {
                id: 'workspace',
                title: t('settings.mcpServersBindingTargetWorkspaceTitle'),
                subtitle: t('settings.mcpServersBindingTargetWorkspaceSubtitle'),
                icon: <Icon name="folder" size={20} color={theme.colors.text.secondary} />,
            },
        ];
    }, [theme.colors.text.secondary]);

    const machineItems = React.useMemo((): DropdownMenuItem[] => {
        const names = resolveMachineDisplayNames(props.machines);
        return props.machines.map((machine) => ({
            id: machine.id,
            title: names.get(machine.id) ?? machine.id,
            subtitle: describeMachinePresenceLine(machine, presenceNowMs, undefined, scope).label,
            icon: <Icon name="laptop" size={20} color={theme.colors.text.secondary} />,
        }));
    }, [props.machines, presenceNowMs, scope, reachabilityRevision, theme.colors.text.secondary]);

    const selectedMachineId = props.target.t === 'allMachines' || props.target.t === 'project'
        ? null
        : props.target.machineId;
    const needsMachineSelection = props.target.t === 'machine' || props.target.t === 'workspace' || pendingMachineScopedTargetType !== null;

    return (
        <>
            <DropdownMenu
                open={openMenu === 'targetType'}
                onOpenChange={(open) => setOpenMenu(open ? 'targetType' : null)}
                items={targetTypeItems}
                selectedId={props.target.t}
                onSelect={(id) => {
                    setOpenMenu(null);
                    const nextType = id as BindingTargetType;
                    if (nextType !== 'allMachines' && props.target.t === 'allMachines') {
                        if (props.machines.length === 0) {
                            props.onChangeTargetType(nextType);
                        } else {
                            if (nextType === 'machine' || nextType === 'workspace') setPendingMachineScopedTargetType(nextType);
                        }
                        return;
                    }
                    setPendingMachineScopedTargetType(null);
                    props.onChangeTargetType(nextType);
                }}
                itemTrigger={{
                    title: t('settings.mcpServersBindingTarget'),
                    subtitle: t('settings.mcpServersBindingTargetSubtitle'),
                }}
                rowKind="item"
                connectToTrigger
                variant="default"
            />

            {needsMachineSelection ? (
                <DropdownMenu
                    open={openMenu === 'machine'}
                    onOpenChange={(open) => setOpenMenu(open ? 'machine' : null)}
                    items={machineItems}
                    selectedId={selectedMachineId}
                    onSelect={(id) => {
                        setOpenMenu(null);
                        if (props.target.t === 'allMachines') {
                            const nextType = pendingMachineScopedTargetType;
                            if (!nextType) return;
                            setPendingMachineScopedTargetType(null);
                            props.onChangeTargetType(nextType, id);
                            return;
                        }
                        props.onChangeMachineId(id);
                    }}
                    itemTrigger={{
                        title: t('settings.mcpServersBindingMachine'),
                        subtitle: t('settings.mcpServersBindingMachineSubtitle'),
                    }}
                    rowKind="item"
                    connectToTrigger
                    variant="default"
                />
            ) : null}

            {props.target.t === 'workspace' ? (
                <Item
                    title={t('settings.mcpServersBindingWorkspaceRootTitle')}
                    subtitle={props.target.workspaceRoot}
                    onPress={props.onOpenWorkspacePicker}
                />
            ) : null}
        </>
    );
});
