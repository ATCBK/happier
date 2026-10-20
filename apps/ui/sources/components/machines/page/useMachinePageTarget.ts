import * as React from 'react';
import { Platform } from 'react-native';

import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { useMachine, useMachineListByServerId } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { areServerProfileIdentifiersEquivalent, getActiveServerId } from '@/sync/domains/server/serverProfiles';
import { setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import { resolveRoutineServerSelectionScope } from '@/sync/domains/server/selection/serverSelectionScope';
import { sync } from '@/sync/sync';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { getMachineSentenceName, resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';

/** The Home that lists this machine: the focused Home first, else the first Home that has it. */
export function resolveMachineServerIdFromList(params: Readonly<{
    activeServerId: string;
    machineId: string | undefined;
    machineListByServerId: Readonly<Record<string, readonly Pick<Machine, 'id'>[] | null | undefined>>;
}>): string {
    const machineId = String(params.machineId ?? '').trim();
    if (!machineId) return '';
    const activeServerMachines = params.machineListByServerId[params.activeServerId];
    if (Array.isArray(activeServerMachines) && activeServerMachines.some((machine) => machine.id === machineId)) {
        return params.activeServerId;
    }
    for (const [serverId, machines] of Object.entries(params.machineListByServerId)) {
        if (Array.isArray(machines) && machines.some((machine) => machine.id === machineId)) return serverId;
    }
    return '';
}

export type MachinePageTarget = Readonly<{
    machineId: string;
    /** The `serverId` the route names, when it names one. */
    requestedServerId: string;
    /** The Home the page reads the machine from. */
    serverId: string;
    activeServerId: string;
    machine: Machine | null;
    machineName: string;
    /** The name inside page sentences: "this machine" while the machine's details are locked or loading. */
    machineSentenceName: string;
    online: boolean;
    /** The page is focusing the Home its link names. */
    isServerSwitching: boolean;
    /** The machine list is being read because the machine is not known yet. */
    isHydratingMachine: boolean;
    /** The focused Home is the one the route names, so machine RPCs reach the right daemon. */
    switchReady: boolean;
}>;

/**
 * The machine a Machines page (or one of its sub-pages) is about, from the route: which Home it
 * belongs to, focusing that Home when the link names another, and reading the machine list once
 * when the machine is not known yet. Every page of one machine resolves it the same way.
 */
export function useMachinePageTarget(): MachinePageTarget {
    const language = usePreferredLanguage();
    const params = useLocalSearchParams<{ id: string; serverId?: string }>();
    const machineId = typeof params.id === 'string' ? params.id : '';
    const machine = useMachine(machineId) ?? null;
    const machineListByServerId = useMachineListByServerId();
    const activeServerId = getActiveServerId();
    const requestedServerId = typeof params.serverId === 'string' ? params.serverId.trim() : '';
    const machineListServerId = React.useMemo(() => resolveMachineServerIdFromList({
        activeServerId, machineId, machineListByServerId,
    }), [activeServerId, machineId, machineListByServerId]);
    const serverId = requestedServerId || machineListServerId || activeServerId;
    const presence = useMachinePresenceSummary(serverId, machineId);
    const [isServerSwitching, setIsServerSwitching] = React.useState(false);
    const [isHydratingMachine, setIsHydratingMachine] = React.useState(() => Boolean(machineId) && !machine);
    const hydrationRequestedRef = React.useRef(false);

    React.useEffect(() => {
        if (!requestedServerId) return;
        if (areServerProfileIdentifiersEquivalent(getActiveServerId(), requestedServerId)) return;
        let cancelled = false;
        setIsServerSwitching(true);
        fireAndForget((async () => {
            try {
                await setActiveServerAndSwitch({
                    serverId: requestedServerId,
                    scope: resolveRoutineServerSelectionScope(Platform.OS, isDesktopHost()),
                });
                await sync.refreshMachinesThrottled({ staleMs: 0, force: true });
            } finally {
                if (!cancelled) setIsServerSwitching(false);
            }
        })(), { tag: 'MachinePage.switchServer' });
        return () => {
            cancelled = true;
        };
    }, [requestedServerId]);

    React.useEffect(() => {
        if (!machineId) return;
        if (machine) {
            hydrationRequestedRef.current = false;
            if (isHydratingMachine) setIsHydratingMachine(false);
            return;
        }
        if (hydrationRequestedRef.current) return;
        hydrationRequestedRef.current = true;
        let cancelled = false;
        setIsHydratingMachine(true);
        fireAndForget((async () => {
            try {
                await sync.refreshMachines();
            } finally {
                if (!cancelled) setIsHydratingMachine(false);
            }
        })(), { tag: 'MachinePage.hydrateMachine' });
        return () => {
            cancelled = true;
        };
    }, [isHydratingMachine, machine, machineId]);

    const machineName = React.useMemo(() => {
        if (!machine) return t('machine.unknownMachine');
        // The same name the lists show, told apart when another machine shares it.
        const homeMachines = machineListByServerId[serverId] ?? [];
        const siblings = homeMachines.some((candidate) => candidate.id === machine.id) ? homeMachines : [...homeMachines, machine];
        return resolveMachineDisplayNames(siblings).get(machine.id) ?? t('machine.unknownMachine');
    }, [language, machine, machineListByServerId, serverId]);
    const machineSentenceName = React.useMemo(() => getMachineSentenceName(machine, machineName), [language, machine, machineName]);

    return {
        machineId,
        requestedServerId,
        serverId,
        activeServerId,
        machine,
        machineName,
        machineSentenceName,
        online: machine ? presence.reachability === 'reachable' : false,
        isServerSwitching,
        isHydratingMachine,
        switchReady: Boolean(machineId) && !isServerSwitching
            && (!requestedServerId || areServerProfileIdentifiersEquivalent(requestedServerId, activeServerId)),
    };
}
