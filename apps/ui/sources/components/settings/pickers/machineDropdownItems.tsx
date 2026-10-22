import { renderDropdownItemIcon } from '@/components/settings/pickers/renderDropdownItemIcon';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { isMachineVisibleForLaunchSelection } from '@/sync/domains/machines/identity/filterVisibleMachines';
import { resolveMachinePickerPresence } from '@/sync/domains/machines/identity/resolveMachinePickerPresence';
import type { MachineReachabilityScope } from '@/sync/domains/machines/reachability/machineReachability';
import { t } from '@/text';

export function getMachineDropdownMenuItems(params: Readonly<{
    machines: readonly Machine[];
    scope?: MachineReachabilityScope | null;
    iconColor: string;
    iconSize?: number;
    includeAuto?: boolean;
    autoTitle?: string;
    autoSubtitle?: string;
    onlineLabel?: string;
    offlineLabel?: string;
}>): readonly DropdownMenuItem[] {
    const iconSize = params.iconSize ?? 22;
    const items: DropdownMenuItem[] = [];

    if (params.includeAuto) {
        items.push({
            id: 'auto',
            title: params.autoTitle ?? 'Auto',
            subtitle: params.autoSubtitle ?? 'Automatically choose a stable machine.',
            icon: renderDropdownItemIcon({
                name: 'sparkle',
                color: params.iconColor,
                size: iconSize,
            }),
        });
    }

    const machines = params.machines.filter(isMachineVisibleForLaunchSelection);
    const names = resolveMachineDisplayNames(machines);
    for (const machine of machines) {
        const presence = resolveMachinePickerPresence(machine, undefined, params.scope);
        items.push({
            id: machine.id,
            title: names.get(machine.id)!,
            subtitle: presence.status === 'unknown' ? t('common.unknown') : presence.status === 'online'
                ? params.onlineLabel ?? 'Online' : params.offlineLabel ?? 'Offline',
            icon: renderDropdownItemIcon({
                name: 'desktop',
                color: params.iconColor,
                size: iconSize,
            }),
        });
    }

    return items;
}
